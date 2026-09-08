import type { Prisma, PrismaClient, UsageStatus } from "@prisma/client";

export interface RecordUsageInput {
  applicationId: string;
  providerId?: string | null;
  otpRequestId?: string | null;
  phoneCountry: string;
  smsCount?: number;
  status: UsageStatus;
  providerCost?: number;
  latencyMs?: number | null;
  error?: string | null;
}

export interface UsageFilters {
  from?: Date;
  to?: Date;
  applicationId?: string;
  providerId?: string;
  status?: UsageStatus;
  country?: string;
  limit?: number;
  offset?: number;
}

function createdAtFilter(filters: UsageFilters): Prisma.UsageEventWhereInput {
  if (!filters.from && !filters.to) return {};
  return {
    createdAt: {
      ...(filters.from ? { gte: filters.from } : {}),
      ...(filters.to ? { lt: filters.to } : {}),
    },
  };
}

export class UsageService {
  constructor(private readonly prisma: PrismaClient) {}

  async record(input: RecordUsageInput): Promise<void> {
    await this.prisma.usageEvent.create({
      data: {
        applicationId: input.applicationId,
        providerId: input.providerId ?? null,
        otpRequestId: input.otpRequestId ?? null,
        phoneCountry: input.phoneCountry,
        smsCount: input.smsCount ?? 1,
        status: input.status,
        providerCost: input.providerCost ?? 0,
        latencyMs: input.latencyMs ?? null,
        error: input.error ?? null,
      },
    });
  }

  async list(filters: UsageFilters) {
    const where: Prisma.UsageEventWhereInput = {
      ...createdAtFilter(filters),
      ...(filters.applicationId ? { applicationId: filters.applicationId } : {}),
      ...(filters.providerId ? { providerId: filters.providerId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.country ? { phoneCountry: filters.country.toUpperCase() } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.usageEvent.findMany({
        where,
        include: {
          application: { select: { id: true, name: true, slug: true } },
          provider: { select: { id: true, name: true, type: true } },
        },
        orderBy: { createdAt: "desc" },
        take: Math.min(Math.max(filters.limit ?? 50, 1), 200),
        skip: Math.max(filters.offset ?? 0, 0),
      }),
      this.prisma.usageEvent.count({ where }),
    ]);
    return { items, total };
  }

  async summary(filters: UsageFilters) {
    const where: Prisma.UsageEventWhereInput = {
      ...createdAtFilter(filters),
      ...(filters.applicationId ? { applicationId: filters.applicationId } : {}),
      ...(filters.providerId ? { providerId: filters.providerId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.country ? { phoneCountry: filters.country.toUpperCase() } : {}),
    };
    const [aggregate, byStatus, byProvider, byApplication, byDay] = await Promise.all([
      this.prisma.usageEvent.aggregate({
        where,
        _count: { _all: true },
        _sum: { smsCount: true, providerCost: true },
      }),
      this.prisma.usageEvent.groupBy({
        by: ["status"],
        where,
        _count: { _all: true },
        _sum: { smsCount: true, providerCost: true },
      }),
      this.prisma.usageEvent.groupBy({
        by: ["providerId"],
        where: { ...where, providerId: { not: null } },
        _count: { _all: true },
        _sum: { smsCount: true, providerCost: true },
      }),
      this.prisma.usageEvent.groupBy({
        by: ["applicationId"],
        where,
        _count: { _all: true },
        _sum: { smsCount: true, providerCost: true },
      }),
      this.prisma.usageEvent.findMany({
        where,
        select: { createdAt: true, smsCount: true, providerCost: true, status: true },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    const totalSms = aggregate._sum.smsCount ?? 0;
    const successSms = byStatus.find((row) => row.status === "SUCCESS")?._sum.smsCount ?? 0;
    const dayMap = new Map<string, { sms: number; cost: number; success: number; failed: number }>();
    for (const row of byDay) {
      const day = row.createdAt.toISOString().slice(0, 10);
      const current = dayMap.get(day) ?? { sms: 0, cost: 0, success: 0, failed: 0 };
      current.sms += row.smsCount;
      current.cost += Number(row.providerCost);
      if (row.status === "SUCCESS") current.success += row.smsCount;
      if (row.status === "FAILED") current.failed += row.smsCount;
      dayMap.set(day, current);
    }

    const providerIds = byProvider.map((row) => row.providerId).filter((id): id is string => Boolean(id));
    const applicationIds = byApplication.map((row) => row.applicationId);
    const [providers, applications] = await Promise.all([
      this.prisma.smsProvider.findMany({ where: { id: { in: providerIds } }, select: { id: true, name: true } }),
      this.prisma.application.findMany({ where: { id: { in: applicationIds } }, select: { id: true, name: true, slug: true } }),
    ]);
    const providerNames = new Map(providers.map((provider) => [provider.id, provider.name]));
    const applicationNames = new Map(applications.map((application) => [application.id, application.name]));

    return {
      totalEvents: aggregate._count._all,
      totalSms,
      successfulSms: successSms,
      failedSms: byStatus.find((row) => row.status === "FAILED")?._sum.smsCount ?? 0,
      rejectedSms: byStatus.find((row) => row.status === "REJECTED")?._sum.smsCount ?? 0,
      rateLimitedSms: byStatus.find((row) => row.status === "RATE_LIMITED")?._sum.smsCount ?? 0,
      quotaExceededSms: byStatus.find((row) => row.status === "QUOTA_EXCEEDED")?._sum.smsCount ?? 0,
      successRate: totalSms > 0 ? Number(((successSms / totalSms) * 100).toFixed(2)) : 0,
      totalCostUsd: Number(aggregate._sum.providerCost ?? 0),
      byStatus,
      byProvider: byProvider.map((row) => ({
        providerId: row.providerId,
        providerName: row.providerId ? providerNames.get(row.providerId) ?? "Unknown" : "Unknown",
        sms: row._sum.smsCount ?? 0,
        costUsd: Number(row._sum.providerCost ?? 0),
      })),
      byApplication: byApplication.map((row) => ({
        applicationId: row.applicationId,
        applicationName: applicationNames.get(row.applicationId) ?? "Unknown",
        sms: row._sum.smsCount ?? 0,
        costUsd: Number(row._sum.providerCost ?? 0),
      })),
      byDay: [...dayMap.entries()].map(([day, values]) => ({ day, ...values })),
    };
  }

  async dashboard() {
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [today, month, activeApplications, activeProviders, providerHealth, topApps, topProviders] = await Promise.all([
      this.summary({ from: startOfDay }),
      this.summary({ from: startOfMonth }),
      this.prisma.application.count({ where: { status: "ACTIVE" } }),
      this.prisma.smsProvider.count({ where: { status: "ACTIVE" } }),
      this.prisma.smsProvider.findMany({
        select: {
          id: true,
          name: true,
          type: true,
          status: true,
          healthStatus: true,
          failureCount: true,
          successCount: true,
          avgResponseMs: true,
          lastSuccessAt: true,
          lastFailureAt: true,
          lastHealthCheckAt: true,
          circuitOpenUntil: true,
        },
        orderBy: { priority: "asc" },
      }),
      this.prisma.usageEvent.groupBy({
        by: ["applicationId"],
        where: { createdAt: { gte: startOfMonth }, status: "SUCCESS" },
        _sum: { smsCount: true, providerCost: true },
        orderBy: { _sum: { smsCount: "desc" } },
        take: 5,
      }),
      this.prisma.usageEvent.groupBy({
        by: ["providerId"],
        where: { createdAt: { gte: startOfMonth }, status: "SUCCESS", providerId: { not: null } },
        _sum: { smsCount: true, providerCost: true },
        orderBy: { _sum: { smsCount: "desc" } },
        take: 5,
      }),
    ]);

    const [appRows, providerRows] = await Promise.all([
      this.prisma.application.findMany({ where: { id: { in: topApps.map((row) => row.applicationId) } }, select: { id: true, name: true } }),
      this.prisma.smsProvider.findMany({ where: { id: { in: topProviders.map((row) => row.providerId).filter((id): id is string => Boolean(id)) } }, select: { id: true, name: true } }),
    ]);
    const appNames = new Map(appRows.map((row) => [row.id, row.name]));
    const providerNames = new Map(providerRows.map((row) => [row.id, row.name]));

    return {
      today: { sms: today.totalSms, costUsd: today.totalCostUsd, successRate: today.successRate },
      month: { sms: month.totalSms, costUsd: month.totalCostUsd, successRate: month.successRate },
      activeApplications,
      activeProviders,
      providerHealth,
      topApplications: topApps.map((row) => ({ applicationId: row.applicationId, name: appNames.get(row.applicationId) ?? "Unknown", sms: row._sum.smsCount ?? 0, costUsd: Number(row._sum.providerCost ?? 0) })),
      topProviders: topProviders.map((row) => ({ providerId: row.providerId, name: row.providerId ? providerNames.get(row.providerId) ?? "Unknown" : "Unknown", sms: row._sum.smsCount ?? 0, costUsd: Number(row._sum.providerCost ?? 0) })),
    };
  }
}
