import type { PrismaClient, ProviderStrategy } from "@prisma/client";
import { AppError } from "../../common/errors.js";
import { generateCredentialPair, verifyApiSecret } from "../../common/crypto.js";
import type { AppContext, OtpPolicyOverrides } from "../otp/otp.types.js";
import type { QuotaLimit } from "../rate-limit/quota.service.js";

export interface CreateApplicationInput {
  name: string;
  slug: string;
  description?: string;
  allowedCountries?: string[];
  otpPolicy?: OtpPolicyOverrides;
  rateLimits?: Record<string, number>;
  providerStrategy?: ProviderStrategy;
  quotas?: Partial<Record<QuotaLimit["type"], number>>;
}

export interface UpdateApplicationInput {
  name?: string;
  description?: string | null;
  status?: "ACTIVE" | "DISABLED";
  allowedCountries?: string[];
  otpPolicy?: OtpPolicyOverrides | null;
  rateLimits?: Record<string, number> | null;
  providerStrategy?: ProviderStrategy;
}

const defaultQuotas: Record<QuotaLimit["type"], number> = {
  DAILY_SMS: 5000,
  MONTHLY_SMS: 100000,
  DAILY_COST_USD: 50,
  MONTHLY_COST_USD: 1000,
};

export class ApplicationService {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateApplicationInput) {
    const credentials = generateCredentialPair();
    try {
      const application = await this.prisma.application.create({
        data: {
          name: input.name,
          slug: input.slug,
          description: input.description ?? null,
          allowedCountries: (input.allowedCountries ?? ["*"]).map((country) => country === "*" ? "*" : country.toUpperCase()),
          otpPolicy: input.otpPolicy ? { ...(input.otpPolicy as Record<string, number>) } : undefined,
          rateLimits: input.rateLimits ? { ...input.rateLimits } : undefined,
          providerStrategy: input.providerStrategy ?? "AUTO",
          credentials: {
            create: { apiKey: credentials.apiKey, secretHash: credentials.secretHash },
          },
          quotas: {
            create: (Object.entries(defaultQuotas) as Array<[QuotaLimit["type"], number]>).map(([type, defaultLimit]) => ({
              type,
              limit: input.quotas?.[type] ?? defaultLimit,
            })),
          },
        },
        include: { credentials: true, quotas: true },
      });
      return {
        application: this.publicApplication({ ...application, credentials: application.credentials, quotas: application.quotas }),
        apiKey: credentials.apiKey,
        apiSecret: credentials.apiSecret,
      };
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") {
        throw AppError.conflict("Application name or slug already exists");
      }
      throw error;
    }
  }

  async findForCredentials(apiKey: string, apiSecret: string): Promise<AppContext | null> {
    const credential = await this.prisma.applicationCredential.findUnique({
      where: { apiKey },
      include: { application: true },
    });
    if (!credential || credential.status !== "ACTIVE") return null;
    if (!verifyApiSecret(apiSecret, credential.secretHash)) return null;
    if (credential.application.status !== "ACTIVE") {
      throw new AppError("APPLICATION_DISABLED", "Application is disabled", 403);
    }
    await this.prisma.applicationCredential.update({
      where: { id: credential.id },
      data: { lastUsedAt: new Date() },
    }).catch(() => undefined);
    return this.toContext(credential.application);
  }

  async list() {
    return this.prisma.application.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        credentials: { select: { id: true, apiKey: true, status: true, lastUsedAt: true, createdAt: true, revokedAt: true } },
        quotas: true,
        _count: { select: { usageEvents: true, otpRequests: true } },
      },
    });
  }

  async get(id: string) {
    const application = await this.prisma.application.findUnique({
      where: { id },
      include: {
        credentials: { select: { id: true, apiKey: true, status: true, lastUsedAt: true, createdAt: true, revokedAt: true } },
        quotas: true,
        _count: { select: { usageEvents: true, otpRequests: true } },
      },
    });
    if (!application) throw AppError.notFound("Application not found");
    return application;
  }

  async update(id: string, input: UpdateApplicationInput) {
    try {
      return await this.prisma.application.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.allowedCountries !== undefined ? { allowedCountries: input.allowedCountries.map((country) => country === "*" ? "*" : country.toUpperCase()) } : {}),
          ...(input.otpPolicy !== undefined ? { otpPolicy: input.otpPolicy === null ? { set: null } : { set: { ...(input.otpPolicy as Record<string, number>) } } } : {}),
          ...(input.rateLimits !== undefined ? { rateLimits: input.rateLimits === null ? { set: null } : { set: { ...input.rateLimits } } } : {}),
          ...(input.providerStrategy !== undefined ? { providerStrategy: input.providerStrategy } : {}),
        },
        include: { quotas: true },
      });
    } catch (error) {
      if ((error as { code?: string }).code === "P2025") throw AppError.notFound("Application not found");
      if ((error as { code?: string }).code === "P2002") throw AppError.conflict("Application name already exists");
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.prisma.application.delete({ where: { id } });
    } catch (error) {
      if ((error as { code?: string }).code === "P2025") throw AppError.notFound("Application not found");
      throw error;
    }
  }

  async rotateCredentials(id: string) {
    const pair = generateCredentialPair();
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.application.findUniqueOrThrow({ where: { id } });
        await tx.applicationCredential.updateMany({
          where: { applicationId: id, status: "ACTIVE" },
          data: { status: "REVOKED", revokedAt: new Date() },
        });
        await tx.applicationCredential.create({
          data: { applicationId: id, apiKey: pair.apiKey, secretHash: pair.secretHash },
        });
      });
      return { apiKey: pair.apiKey, apiSecret: pair.apiSecret };
    } catch (error) {
      if ((error as { code?: string }).code === "P2025") throw AppError.notFound("Application not found");
      throw error;
    }
  }

  /** Adds an extra ACTIVE credential without revoking the existing ones. */
  async createCredential(id: string) {
    const pair = generateCredentialPair();
    try {
      await this.prisma.application.update({ where: { id }, data: {} });
    } catch (error) {
      if ((error as { code?: string }).code === "P2025") throw AppError.notFound("Application not found");
      throw error;
    }
    await this.prisma.applicationCredential.create({
      data: { applicationId: id, apiKey: pair.apiKey, secretHash: pair.secretHash },
    });
    return { apiKey: pair.apiKey, apiSecret: pair.apiSecret };
  }

  async revokeCredential(applicationId: string, credentialId: string): Promise<void> {
    const updated = await this.prisma.applicationCredential.updateMany({
      where: { id: credentialId, applicationId, status: "ACTIVE" },
      data: { status: "REVOKED", revokedAt: new Date() },
    });
    if (updated.count === 0) throw AppError.notFound("Active credential not found");
  }

  async getQuotas(applicationId: string): Promise<QuotaLimit[]> {
    const rows = await this.prisma.quota.findMany({ where: { applicationId } });
    return rows.map((row) => ({ type: row.type, limit: Number(row.limit), enabled: row.enabled }));
  }

  async prismaQuotas(applicationId: string) {
    return this.prisma.quota.findMany({
      where: { applicationId },
      orderBy: { type: "asc" },
    });
  }

  async updateQuota(id: string, limit: number, enabled?: boolean) {
    try {
      return await this.prisma.quota.update({
        where: { id },
        data: { limit, ...(enabled === undefined ? {} : { enabled }) },
      });
    } catch (error) {
      if ((error as { code?: string }).code === "P2025") throw AppError.notFound("Quota not found");
      throw error;
    }
  }

  private publicApplication(application: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    status: "ACTIVE" | "DISABLED";
    allowedCountries: string[];
    otpPolicy: unknown;
    rateLimits: unknown;
    providerStrategy: ProviderStrategy;
    createdAt: Date;
    updatedAt: Date;
    credentials: Array<{
      id: string;
      apiKey: string;
      status: string;
      lastUsedAt: Date | null;
      createdAt: Date;
      revokedAt: Date | null;
      secretHash?: string;
    }>;
    quotas: Array<unknown>;
    _count?: unknown;
  }) {
    return {
      ...application,
      credentials: application.credentials.map(({ secretHash: _secretHash, ...credential }) => credential),
    };
  }

  toContext(application: {
    id: string;
    name: string;
    status: "ACTIVE" | "DISABLED";
    allowedCountries: string[];
    otpPolicy: unknown;
    rateLimits: unknown;
    providerStrategy: ProviderStrategy;
  }): AppContext {
    return {
      id: application.id,
      name: application.name,
      status: application.status,
      allowedCountries: application.allowedCountries,
      otpPolicy: (application.otpPolicy as OtpPolicyOverrides | null) ?? null,
      rateLimits: (application.rateLimits as AppContext["rateLimits"]) ?? null,
      providerStrategy: application.providerStrategy,
    };
  }
}
