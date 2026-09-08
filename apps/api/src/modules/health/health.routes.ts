import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { checkDatabase } from "../../infrastructure/database/prisma.js";
import { checkRedis } from "../../infrastructure/redis/redis.store.js";
import type { ProviderManager } from "../providers/provider.manager.js";

export interface HealthDependencies {
  prisma: PrismaClient;
  redis: Redis;
  providers: ProviderManager;
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthDependencies): void {
  app.get("/health/live", {
    schema: { tags: ["Health"], summary: "Liveness probe" },
  }, async (_request, reply) => reply.code(200).send({ status: "ok" }));

  app.get("/health/ready", {
    schema: { tags: ["Health"], summary: "Readiness probe" },
  }, async (_request, reply) => {
    const [database, redis, providers] = await Promise.all([
      checkDatabase(),
      checkRedis(deps.redis),
      deps.providers.getActiveProviders().then((items) => items.length > 0).catch(() => false),
    ]);
    const ready = database && redis && providers;
    return reply.code(ready ? 200 : 503).send({
      status: ready ? "ok" : "not_ready",
      checks: { database, redis, providers },
    });
  });

  app.get("/health", {
    schema: { tags: ["Health"], summary: "Detailed service health" },
  }, async (_request, reply) => {
    const [database, redis, activeProviders] = await Promise.all([
      checkDatabase(),
      checkRedis(deps.redis),
      deps.providers.getActiveProviders().catch(() => []),
    ]);
    const ready = database && redis && activeProviders.length > 0;
    return reply.code(ready ? 200 : 503).send({
      status: ready ? "ok" : "degraded",
      checks: {
        database: database ? "up" : "down",
        redis: redis ? "up" : "down",
        providers: activeProviders.length > 0 ? "up" : "down",
      },
      provider_count: activeProviders.length,
    });
  });
}
