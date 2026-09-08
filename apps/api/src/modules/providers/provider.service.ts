import type { Prisma, PrismaClient } from "@prisma/client";
import { AppError } from "../../common/errors.js";
import type { EncryptionService } from "../../infrastructure/encryption/encryption.js";
import { getAdapter, listAdapterTypes } from "./provider.registry.js";
import type { ProviderManager } from "./provider.manager.js";

export interface ProviderInput {
  name: string;
  type: string;
  status?: "ACTIVE" | "INACTIVE";
  priority?: number;
  weight?: number;
  costPerSms?: number;
  credentials?: Record<string, string>;
  config?: Record<string, unknown>;
  timeoutMs?: number;
  maxRetries?: number;
  supportedCountries?: string[];
}

export interface ProviderUpdateInput {
  name?: string;
  type?: string;
  status?: "ACTIVE" | "INACTIVE";
  priority?: number;
  weight?: number;
  costPerSms?: number;
  credentials?: Record<string, string>;
  config?: Record<string, unknown>;
  timeoutMs?: number;
  maxRetries?: number;
  supportedCountries?: string[];
}

function sanitizeConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeConfig);
  if (!value || typeof value !== "object") return value;
  const sensitive = /secret|token|password|credential|authorization|api[-_]?key/i;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
    key,
    sensitive.test(key) ? "[REDACTED]" : sanitizeConfig(child),
  ]));
}

function publicProvider(provider: {
  id: string;
  name: string;
  type: string;
  status: string;
  priority: number;
  weight: number;
  costPerSms: unknown;
  config: unknown;
  timeoutMs: number;
  maxRetries: number;
  supportedCountries: string[];
  healthStatus: string;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastHealthCheckAt: Date | null;
  successCount: number;
  failureCount: number;
  avgResponseMs: number;
  circuitOpenUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
  credentialsEncrypted?: string | null;
}) {
  const total = provider.successCount + provider.failureCount;
  return {
    id: provider.id,
    name: provider.name,
    type: provider.type,
    status: provider.status,
    priority: provider.priority,
    weight: provider.weight,
    costPerSms: Number(provider.costPerSms),
    config: sanitizeConfig(provider.config),
    timeoutMs: provider.timeoutMs,
    maxRetries: provider.maxRetries,
    supportedCountries: provider.supportedCountries,
    healthStatus: provider.healthStatus,
    successCount: provider.successCount,
    failureCount: provider.failureCount,
    successRate: total > 0 ? Number(((provider.successCount / total) * 100).toFixed(2)) : 0,
    avgResponseMs: provider.avgResponseMs,
    lastSuccessAt: provider.lastSuccessAt,
    lastFailureAt: provider.lastFailureAt,
    lastHealthCheckAt: provider.lastHealthCheckAt,
    circuitOpenUntil: provider.circuitOpenUntil,
    credentialsConfigured: Boolean(provider.credentialsEncrypted),
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

export class ProviderService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly encryption: EncryptionService,
    private readonly manager: ProviderManager,
  ) {}

  supportedTypes(): string[] {
    return listAdapterTypes();
  }

  async create(input: ProviderInput) {
    this.assertType(input.type);
    const credentialsEncrypted = input.credentials
      ? this.encryption.encryptJson(input.credentials)
      : null;
    try {
      const provider = await this.prisma.smsProvider.create({
        data: {
          name: input.name,
          type: input.type.toUpperCase(),
          status: input.status ?? "ACTIVE",
          priority: input.priority ?? 100,
          weight: input.weight ?? 1,
          costPerSms: input.costPerSms ?? 0,
          credentialsEncrypted,
          config: input.config ? (input.config as Prisma.InputJsonValue) : undefined,
          timeoutMs: input.timeoutMs ?? 10000,
          maxRetries: input.maxRetries ?? 0,
          supportedCountries: (input.supportedCountries ?? ["*"]).map((country) => country === "*" ? "*" : country.toUpperCase()),
          prices: {
            create: {
              pricePerSms: input.costPerSms ?? 0,
              currency: "USD",
              effectiveFrom: new Date(),
            },
          },
        },
      });
      this.manager.invalidateCache();
      return publicProvider(provider);
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") {
        throw AppError.conflict("Provider name already exists");
      }
      throw error;
    }
  }

  async list() {
    const providers = await this.prisma.smsProvider.findMany({ orderBy: [{ priority: "asc" }, { name: "asc" }] });
    return providers.map(publicProvider);
  }

  async get(id: string) {
    const provider = await this.prisma.smsProvider.findUnique({ where: { id } });
    if (!provider) throw AppError.notFound("Provider not found");
    return publicProvider(provider);
  }

  async update(id: string, input: ProviderUpdateInput) {
    const existing = await this.prisma.smsProvider.findUnique({ where: { id } });
    if (!existing) throw AppError.notFound("Provider not found");
    if (input.type) this.assertType(input.type);

    const credentialsEncrypted = input.credentials === undefined
      ? undefined
      : this.encryption.encryptJson(input.credentials);
    const provider = await this.prisma.smsProvider.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.type !== undefined ? { type: input.type.toUpperCase() } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.weight !== undefined ? { weight: input.weight } : {}),
        ...(input.costPerSms !== undefined ? { costPerSms: input.costPerSms } : {}),
        ...(credentialsEncrypted !== undefined ? { credentialsEncrypted } : {}),
        ...(input.config !== undefined ? { config: input.config ? (input.config as Prisma.InputJsonValue) : { set: null } } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.maxRetries !== undefined ? { maxRetries: input.maxRetries } : {}),
        ...(input.supportedCountries !== undefined ? { supportedCountries: input.supportedCountries.map((country) => country === "*" ? "*" : country.toUpperCase()) } : {}),
      },
    });

    if (input.costPerSms !== undefined && Number(existing.costPerSms) !== input.costPerSms) {
      await this.prisma.providerPrice.create({
        data: {
          providerId: id,
          pricePerSms: input.costPerSms,
          currency: "USD",
          effectiveFrom: new Date(),
        },
      });
    }
    this.manager.invalidateCache();
    return publicProvider(provider);
  }

  async forceDisable(id: string) {
    const provider = await this.prisma.smsProvider.updateMany({
      where: { id },
      data: { status: "INACTIVE" },
    });
    if (provider.count === 0) throw AppError.notFound("Provider not found");
    this.manager.invalidateCache();
    return this.get(id);
  }

  async prices(id: string) {
    await this.ensureExists(id);
    return this.prisma.providerPrice.findMany({
      where: { providerId: id },
      orderBy: { effectiveFrom: "desc" },
      select: { id: true, providerId: true, pricePerSms: true, currency: true, effectiveFrom: true, createdAt: true },
    });
  }

  async addPrice(id: string, pricePerSms: number, currency = "USD", effectiveFrom = new Date()) {
    await this.ensureExists(id);
    const [price] = await this.prisma.$transaction([
      this.prisma.providerPrice.create({
        data: { providerId: id, pricePerSms, currency, effectiveFrom },
      }),
      this.prisma.smsProvider.update({ where: { id }, data: { costPerSms: pricePerSms } }),
    ]);
    this.manager.invalidateCache();
    return price;
  }

  async health(id: string) {
    await this.ensureExists(id);
    return this.manager.healthService.getSnapshot(id);
  }

  async test(id: string, phone: string, message: string) {
    await this.ensureExists(id);
    return this.manager.sendViaProvider(id, { phone, message, purpose: "admin_test" });
  }

  private async ensureExists(id: string): Promise<void> {
    const exists = await this.prisma.smsProvider.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw AppError.notFound("Provider not found");
  }

  private assertType(type: string): void {
    if (!getAdapter(type)) {
      throw AppError.validation(`Unsupported provider type. Supported types: ${listAdapterTypes().join(", ")}`);
    }
  }
}
