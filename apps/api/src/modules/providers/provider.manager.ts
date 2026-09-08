import type { PrismaClient, ProviderStrategy, SmsProvider } from "@prisma/client";
import type { Logger } from "../../infrastructure/logging/logger.js";
import type { EncryptionService } from "../../infrastructure/encryption/encryption.js";
import type { KeyValueStore } from "../../infrastructure/redis/store.js";
import type { SendFailureKind, SmsProviderAdapter, SendSmsParams, SendSmsResult } from "./provider.interface.js";
import { getAdapter, listAdapterTypes } from "./provider.registry.js";
import { ProviderHealthService } from "./provider.health.js";
import { PricingService } from "./pricing.service.js";
import { AppError } from "../../common/errors.js";

export interface ProviderRuntime {
  id: string;
  name: string;
  type: string;
  priority: number;
  weight: number;
  costPerSms: number;
  supportedCountries: string[];
  healthStatus: string;
  adapter: SmsProviderAdapter;
}

export interface GatewaySendOutcome {
  ok: boolean;
  providerId: string | null;
  providerName: string | null;
  providerType: string | null;
  costUsd: number;
  latencyMs: number;
  error?: string;
  failureKind?: SendFailureKind;
  attempts: number;
  messageId?: string;
}

export interface SendRequest {
  phone: string;
  message: string;
  purpose?: string;
  countryIso: string;
  strategy: ProviderStrategy;
}

export interface FailoverConfig {
  maxProviderFailover: number;
}

const PROVIDER_CACHE_TTL_MS = 5000;

/**
 * Owns provider selection, instantiation and the failover send loop.
 * The OTP core calls `smsGateway.send(...)` and never knows the provider.
 */
export class ProviderManager {
  private readonly health: ProviderHealthService;
  private readonly pricing: PricingService;
  private cache: { providers: ProviderRuntime[]; loadedAt: number } | null = null;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly store: KeyValueStore,
    private readonly encryption: EncryptionService,
    private readonly failover: FailoverConfig,
    private readonly cbConfig: { failureThreshold: number; cooldownSeconds: number },
    private readonly log: Logger,
  ) {
    this.health = new ProviderHealthService(store, prisma, cbConfig, log);
    this.pricing = new PricingService(prisma);
  }

  get healthService(): ProviderHealthService {
    return this.health;
  }

  get pricingService(): PricingService {
    return this.pricing;
  }

  /** Active providers with instantiated adapters (cached briefly). */
  async getActiveProviders(forceRefresh = false): Promise<ProviderRuntime[]> {
    if (!forceRefresh && this.cache && Date.now() - this.cache.loadedAt < PROVIDER_CACHE_TTL_MS) {
      return this.cache.providers;
    }
    const rows = await this.prisma.smsProvider.findMany({ where: { status: "ACTIVE" } });
    const providers: ProviderRuntime[] = [];
    for (const row of rows) {
      const runtime = this.toRuntime(row);
      if (runtime) providers.push(runtime);
    }
    this.cache = { providers, loadedAt: Date.now() };
    return providers;
  }

  /** Invalidate cache after admin changes. */
  invalidateCache(): void {
    this.cache = null;
  }

  async estimateCost(request: SendRequest): Promise<number> {
    const providers = await this.getActiveProviders();
    // Include every eligible active provider in the estimate, including one
    // whose DB health snapshot is DOWN. Selection strategies other than AUTO
    // may still consider it when its Redis circuit is closed, and reserving
    // only healthy prices could under-reserve a cost quota.
    const pool = providers.filter((provider) =>
      provider.supportedCountries.includes("*") || provider.supportedCountries.includes(request.countryIso),
    );
    if (pool.length === 0) throw AppError.noProviderAvailable();
    const prices = await Promise.all(pool.map(async (provider) => {
      try { return await this.pricing.resolvePrice(provider); } catch { return provider.costPerSms; }
    }));
    // Reserve the most expensive eligible provider. AUTO/PRIORITY may fail
    // over to a more expensive provider, so reserving the cheapest price would
    // let concurrent requests bypass a cost quota during settlement.
    return Math.max(...prices);
  }

  async send(request: SendRequest): Promise<GatewaySendOutcome> {
    const all = await this.getActiveProviders();
    const candidates = all.filter(
      (p) => p.supportedCountries.includes("*") || p.supportedCountries.includes(request.countryIso),
    );
    if (candidates.length === 0) {
      throw AppError.noProviderAvailable();
    }

    const ordered = this.orderProviders(candidates, request.strategy);
    const maxAttempts = 1 + Math.max(0, this.failover.maxProviderFailover);
    let attempts = 0;

    for (const provider of ordered.slice(0, maxAttempts)) {
      if (await this.health.isCircuitOpen(provider.id)) continue;
      attempts += 1;
      const started = Date.now();
      let result: SendSmsResult;
      try {
        result = await provider.adapter.sendSms({
          phone: request.phone,
          message: request.message,
          purpose: request.purpose,
        });
      } catch (err) {
        // An unexpected adapter crash is not retried automatically: its send
        // outcome is unknown and another attempt could duplicate the SMS.
        result = { ok: false, error: `adapter crashed: ${(err as Error).message}`, retryable: false, kind: "UNKNOWN" };
      }
      const latencyMs = Date.now() - started;

      // Health/metrics side effects — failures here must never break sending.
      this.health.recordResult(provider.id, result, latencyMs).catch((err) =>
        this.log.warn({ err, providerId: provider.id }, "health recording failed"),
      );
      if (!result.ok) {
        metricsProviderFailures(provider.id).catch(() => undefined);
      }

      if (result.ok) {
        // The provider has already accepted the message. A pricing/DB outage
        // must not turn this into an error response, otherwise a client may
        // retry and create a duplicate SMS. Fall back to the provider row's
        // current cost; usage can still be recorded with that snapshot.
        let costUsd = provider.costPerSms;
        try {
          costUsd = await this.pricing.resolvePrice(provider);
        } catch (error) {
          this.log.warn({ err: error, providerId: provider.id }, "Price lookup failed after SMS delivery; using fallback cost");
        }
        return {
          ok: true,
          providerId: provider.id,
          providerName: provider.name,
          providerType: provider.type,
          costUsd,
          latencyMs,
          attempts,
          messageId: result.providerMessageId,
        };
      }

      // Failover only when the provider definitively did not accept the message.
      const isLast = attempts >= maxAttempts || provider.id === ordered[Math.min(maxAttempts, ordered.length) - 1]?.id;
      if (!result.retryable || isLast) {
        return {
          ok: false,
          providerId: provider.id,
          providerName: provider.name,
          providerType: provider.type,
          costUsd: 0,
          latencyMs,
          error: result.error,
          failureKind: result.kind,
          attempts,
        };
      }
      this.log.warn(
        { providerId: provider.id, provider: provider.name, error: result.error },
        "Provider send failed — failing over to next provider",
      );
    }

    return {
      ok: false,
      providerId: null,
      providerName: null,
      providerType: null,
      costUsd: 0,
      latencyMs: 0,
      error: "No provider accepted the message",
      attempts,
    };
  }

  /** Direct send through one specific provider (admin "Test SMS"). */
  async sendViaProvider(providerId: string, params: SendSmsParams): Promise<GatewaySendOutcome> {
    const row = await this.prisma.smsProvider.findUnique({ where: { id: providerId } });
    if (!row) throw AppError.notFound("Provider not found");
    const runtime = this.toRuntime(row);
    if (!runtime) throw AppError.conflict("Provider type has no registered adapter");

    const started = Date.now();
    const result = await runtime.adapter.sendSms(params).catch(
      (err): SendSmsResult => ({ ok: false, error: (err as Error).message, retryable: false, kind: "UNKNOWN" }),
    );
    const latencyMs = Date.now() - started;
    this.health.recordResult(providerId, result, latencyMs).catch(() => undefined);

    if (result.ok) {
      let costUsd = Number(row.costPerSms);
      try {
        costUsd = await this.pricing.resolvePrice(row);
      } catch (error) {
        this.log.warn({ err: error, providerId }, "Price lookup failed after test SMS; using fallback cost");
      }
      return {
        ok: true, providerId, providerName: row.name, providerType: row.type,
        costUsd, latencyMs, attempts: 1, messageId: result.providerMessageId,
      };
    }
    return {
      ok: false, providerId, providerName: row.name,      providerType: row.type,
      costUsd: 0, latencyMs, error: result.error, failureKind: result.kind, attempts: 1,
    };
  }

  /**
   * Strategy implementations.
   * AUTO: prefer healthy providers, order by priority then cost.
   */
  orderProviders(candidates: ProviderRuntime[], strategy: ProviderStrategy): ProviderRuntime[] {
    const byPriority = (a: ProviderRuntime, b: ProviderRuntime) => a.priority - b.priority;
    const byCost = (a: ProviderRuntime, b: ProviderRuntime) => a.costPerSms - b.costPerSms;

    switch (strategy) {
      case "PRIORITY":
        return [...candidates].sort(byPriority);
      case "CHEAPEST":
        return [...candidates].sort((a, b) => byCost(a, b) || byPriority(a, b));
      case "WEIGHTED":
        return this.weightedOrder(candidates);
      case "AUTO":
      default: {
        const healthy = candidates.filter((p) => p.healthStatus !== "DOWN");
        const pool = healthy.length > 0 ? healthy : candidates;
        return [...pool].sort((a, b) => byPriority(a, b) || byCost(a, b));
      }
    }
  }

  /** Weighted random ordering: pick without replacement proportional to weight. */
  private weightedOrder(candidates: ProviderRuntime[]): ProviderRuntime[] {
    const pool = [...candidates];
    const ordered: ProviderRuntime[] = [];
    while (pool.length > 0) {
      const totalWeight = pool.reduce((sum, p) => sum + Math.max(1, p.weight), 0);
      let roll = Math.random() * totalWeight;
      let index = 0;
      for (let i = 0; i < pool.length; i++) {
        roll -= Math.max(1, pool[i]!.weight);
        if (roll <= 0) {
          index = i;
          break;
        }
      }
      ordered.push(pool.splice(index, 1)[0]!);
    }
    return ordered;
  }

  private toRuntime(row: SmsProvider): ProviderRuntime | null {
    const factory = getAdapter(row.type);
    if (!factory) {
      this.log.warn(
        { providerId: row.id, type: row.type, known: listAdapterTypes() },
        "No adapter registered for provider type",
      );
      return null;
    }
    let credentials: Record<string, string> = {};
    if (row.credentialsEncrypted) {
      try {
        credentials = this.encryption.decryptJson<Record<string, string>>(row.credentialsEncrypted);
      } catch (err) {
        this.log.error({ err, providerId: row.id }, "Failed to decrypt provider credentials");
        return null;
      }
    }
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      priority: row.priority,
      weight: row.weight,
      costPerSms: Number(row.costPerSms),
      supportedCountries: row.supportedCountries,
      healthStatus: row.healthStatus,
      adapter: factory({
        providerId: row.id,
        name: row.name,
        timeoutMs: row.timeoutMs,
        credentials,
        config: (row.config as Record<string, unknown> | null) ?? {},
      }),
    };
  }
}

// Lazy import indirection to avoid a hard dependency cycle with the metrics module.
let metricsFn: ((providerId: string) => Promise<void>) | null = null;
export function setProviderFailureMetric(fn: (providerId: string) => Promise<void>): void {
  metricsFn = fn;
}
function metricsProviderFailures(providerId: string): Promise<void> {
  return metricsFn ? metricsFn(providerId) : Promise.resolve();
}
