import type { PrismaClient } from "@prisma/client";
import type { KeyValueStore } from "../../infrastructure/redis/store.js";
import type { Logger } from "../../infrastructure/logging/logger.js";
import type { SendSmsResult } from "./provider.interface.js";

export interface CircuitBreakerConfig {
  failureThreshold: number;
  cooldownSeconds: number;
}

export interface HealthSnapshot {
  status: "HEALTHY" | "DEGRADED" | "DOWN" | "UNKNOWN";
  circuitOpen: boolean;
  circuitOpenUntil: number | null;
  consecutiveFailures: number;
}

/**
 * Circuit breaker + health tracking. Live state lives in Redis:
 *   cb:fails:{providerId}  — consecutive failure counter
 *   cb:open:{providerId}   — open marker with cooldown TTL
 * DB holds the slow-changing snapshot for reporting and the admin panel.
 */
export class ProviderHealthService {
  constructor(
    private readonly store: KeyValueStore,
    private readonly prisma: PrismaClient,
    private readonly config: CircuitBreakerConfig,
    private readonly log: Logger,
  ) {}

  async isCircuitOpen(providerId: string): Promise<boolean> {
    const open = await this.store.get(`cb:open:${providerId}`);
    return open === "1";
  }

  async getSnapshot(providerId: string): Promise<HealthSnapshot> {
    const [open, failures] = await Promise.all([
      this.isCircuitOpen(providerId),
      this.getConsecutiveFailures(providerId),
    ]);
    let openUntil: number | null = null;
    if (open) {
      const ttl = await this.store.ttl(`cb:open:${providerId}`);
      openUntil = ttl > 0 ? Date.now() + ttl * 1000 : null;
    }
    return {
      status: open ? "DOWN" : failures >= this.config.failureThreshold / 2 ? "DEGRADED" : failures > 0 ? "UNKNOWN" : "HEALTHY",
      circuitOpen: open,
      circuitOpenUntil: openUntil,
      consecutiveFailures: failures,
    };
  }

  /** Called after each send attempt. Updates Redis + DB snapshot. */
  async recordResult(providerId: string, result: SendSmsResult, latencyMs: number): Promise<void> {
    const failsKey = `cb:fails:${providerId}`;

    if (result.ok) {
      await this.store.del(failsKey);
      await this.store.del(`cb:open:${providerId}`);
      await this.prisma.smsProvider.update({
        where: { id: providerId },
        data: {
          healthStatus: "HEALTHY",
          lastSuccessAt: new Date(),
          successCount: { increment: 1 },
          circuitOpenUntil: null,
        },
      }).catch((err) => this.log.warn({ err, providerId }, "Failed to update provider health"));
      await this.updateAvgLatency(providerId, latencyMs);
      return;
    }

    const failures = await this.store.incr(failsKey, this.config.cooldownSeconds * 2);

    if (failures >= this.config.failureThreshold) {
      // Open the circuit — provider excluded from selection until cooldown passes.
      await this.store.set(`cb:open:${providerId}`, "1", this.config.cooldownSeconds);
      await this.prisma.smsProvider.update({
        where: { id: providerId },
        data: {
          healthStatus: "DOWN",
          lastFailureAt: new Date(),
          failureCount: { increment: 1 },
          circuitOpenUntil: new Date(Date.now() + this.config.cooldownSeconds * 1000),
        },
      }).catch((err) => this.log.warn({ err, providerId }, "Failed to update provider health"));
      this.log.warn({ providerId, failures }, "Provider circuit opened");
      return;
    }

    await this.prisma.smsProvider.update({
      where: { id: providerId },
      data: {
        healthStatus: failures >= this.config.failureThreshold / 2 ? "DEGRADED" : "HEALTHY",
        lastFailureAt: new Date(),
        failureCount: { increment: 1 },
      },
    }).catch((err) => this.log.warn({ err, providerId }, "Failed to update provider health"));
  }

  /** Run a manual/periodic health check via the adapter (optional). */
  async runHealthCheck(
    providerId: string,
    check: () => Promise<{ status: string; detail?: string }>,
  ): Promise<{ status: string; detail?: string }> {
    const result = await check().catch((err) => ({ status: "DOWN", detail: (err as Error).message }));
    const normalized = result.status.toUpperCase();
    const healthStatus = normalized === "HEALTHY" || normalized === "DEGRADED" || normalized === "DOWN" || normalized === "UNKNOWN"
      ? normalized as "HEALTHY" | "DEGRADED" | "DOWN" | "UNKNOWN"
      : "UNKNOWN";
    await this.prisma.smsProvider.update({
      where: { id: providerId },
      data: { lastHealthCheckAt: new Date(), healthStatus },
    }).catch(() => undefined);
    return { ...result, status: healthStatus };
  }

  private async getConsecutiveFailures(providerId: string): Promise<number> {
    const raw = await this.store.get(`cb:fails:${providerId}`);
    return raw ? Number(raw) : 0;
  }

  private async updateAvgLatency(providerId: string, latencyMs: number): Promise<void> {
    try {
      const provider = await this.prisma.smsProvider.findUnique({
        where: { id: providerId },
        select: { avgResponseMs: true, successCount: true },
      });
      if (!provider) return;
      const total = provider.successCount;
      const avg = total > 1
        ? Math.round((provider.avgResponseMs * (total - 1) + latencyMs) / total)
        : latencyMs;
      await this.prisma.smsProvider.update({ where: { id: providerId }, data: { avgResponseMs: avg } });
    } catch (err) {
      this.log.warn({ err, providerId }, "Failed to update avg latency");
    }
  }
}
