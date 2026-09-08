import type { Prisma, PrismaClient } from "@prisma/client";

export interface AuditInput {
  actor: string;
  action: string;
  resource: string;
  resourceId?: string | null;
  ip?: string | null;
  applicationId?: string | null;
  metadata?: Record<string, unknown>;
}

export class AuditService {
  constructor(private readonly prisma: PrismaClient) {}

  async record(input: AuditInput): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actor: input.actor,
        action: input.action,
        resource: input.resource,
        resourceId: input.resourceId ?? null,
        ip: input.ip ?? null,
        applicationId: input.applicationId ?? null,
        metadata: input.metadata ? (input.metadata as Prisma.InputJsonValue) : undefined,
      },
    });
  }

  async list(limit = 100, offset = 0) {
    const take = Math.min(Math.max(limit, 1), 200);
    const skip = Math.max(offset, 0);
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        orderBy: { createdAt: "desc" },
        take,
        skip,
      }),
      this.prisma.auditLog.count(),
    ]);
    return { items, total };
  }
}
