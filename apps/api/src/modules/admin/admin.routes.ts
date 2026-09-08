import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { AppError } from "../../common/errors.js";
import { parseBody, zodJsonSchema } from "../../common/route-helpers.js";
import { checkDatabase } from "../../infrastructure/database/prisma.js";
import { checkRedis } from "../../infrastructure/redis/redis.store.js";
import type { Redis } from "ioredis";
import type { PrismaClient } from "@prisma/client";
import type { AuditService } from "./audit.service.js";
import type { ProviderManager } from "../providers/provider.manager.js";
import type { UsageService } from "../usage/usage.service.js";

const rateLimitPatch = z.object({
  limit: z.number().int().positive().max(1000000).optional(),
  windowSeconds: z.number().int().positive().max(86400).optional(),
  enabled: z.boolean().optional(),
  description: z.string().max(500).nullable().optional(),
});

function cuidParam(value: unknown): string {
  const parsed = z.string().cuid().safeParse(value);
  if (!parsed.success) throw AppError.validation("Resource id must be a valid id");
  return parsed.data;
}

export interface AdminRouteDependencies {
  prisma: PrismaClient;
  redis: Redis;
  providers: ProviderManager;
  usage: UsageService;
  audit: AuditService;
  adminAuth: preHandlerHookHandler;
}

export function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDependencies): void {
  const preHandler = deps.adminAuth;

  app.get("/api/v1/admin/auth/verify", { preHandler, schema: { tags: ["Admin"], summary: "Verify admin credentials" } }, async (_request, reply) => {
    return reply.send({ authenticated: true });
  });

  app.get("/api/v1/admin/dashboard", { preHandler, schema: { tags: ["Admin"], summary: "Get dashboard metrics" } }, async (_request, reply) => {
    return reply.send(await deps.usage.dashboard());
  });

  app.get("/api/v1/admin/rate-limits", { preHandler, schema: { tags: ["Admin Rate Limits"], summary: "List global rate-limit configurations" } }, async (_request, reply) => {
    return reply.send({ items: await deps.prisma.rateLimitConfig.findMany({ orderBy: { key: "asc" } }) });
  });

  app.patch("/api/v1/admin/rate-limits/:id", {
    preHandler,
    schema: { tags: ["Admin Rate Limits"], summary: "Update a global rate-limit configuration", body: zodJsonSchema(rateLimitPatch) },
  }, async (request, reply) => {
    const id = cuidParam((request.params as { id?: unknown }).id);
    const body = parseBody(rateLimitPatch, request.body);
    try {
      const result = await deps.prisma.rateLimitConfig.update({ where: { id }, data: body });
      await deps.audit.record({ actor: "admin", action: "rate_limit.changed", resource: "rate_limit_config", resourceId: id, ip: request.ip, metadata: { fields: Object.keys(body) } });
      return reply.send(result);
    } catch (error) {
      if ((error as { code?: string }).code === "P2025") throw AppError.notFound("Rate-limit configuration not found");
      throw error;
    }
  });

  app.get("/api/v1/admin/system/health", { preHandler, schema: { tags: ["Admin System"], summary: "Get admin system health" } }, async (_request, reply) => {
    const [database, redis, activeProviders] = await Promise.all([
      checkDatabase(),
      checkRedis(deps.redis),
      deps.providers.getActiveProviders().catch(() => []),
    ]);
    const providerHealth = await Promise.all(activeProviders.map(async (provider) => ({
      providerId: provider.id,
      name: provider.name,
      health: await deps.providers.healthService.getSnapshot(provider.id),
    })));
    return reply.send({
      status: database && redis ? "ok" : "degraded",
      database,
      redis,
      providerHealth,
    });
  });
}
