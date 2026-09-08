import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { buildConfig, parseConfig, type AppConfig } from "./config.js";
import { AppError, ERROR_CODES } from "./common/errors.js";
import { createLogger, type Logger } from "./infrastructure/logging/logger.js";
import { createPrismaClient } from "./infrastructure/database/prisma.js";
import { createRedisClient } from "./infrastructure/redis/redis.client.js";
import { RedisStore } from "./infrastructure/redis/redis.store.js";
import { EncryptionService } from "./infrastructure/encryption/encryption.js";
import { ApplicationService } from "./modules/applications/application.service.js";
import { AuditService } from "./modules/admin/audit.service.js";
import { createAdminAuthenticator } from "./modules/admin/admin.auth.js";
import { ProviderManager, setProviderFailureMetric } from "./modules/providers/provider.manager.js";
import { ProviderService } from "./modules/providers/provider.service.js";
import { RateLimitService } from "./modules/rate-limit/rate-limit.service.js";
import { QuotaService } from "./modules/rate-limit/quota.service.js";
import { IdempotencyService } from "./modules/otp/idempotency.service.js";
import { OtpService } from "./modules/otp/otp.service.js";
import { PrismaOtpRepository } from "./modules/otp/otp.repository.js";
import { UsageService } from "./modules/usage/usage.service.js";
import { MetricsService } from "./modules/metrics/metrics.service.js";
import { registerOtpRoutes } from "./modules/otp/otp.routes.js";
import { registerApplicationRoutes } from "./modules/applications/application.routes.js";
import { registerProviderRoutes } from "./modules/providers/provider.routes.js";
import { registerUsageRoutes } from "./modules/usage/usage.routes.js";
import { registerAdminRoutes } from "./modules/admin/admin.routes.js";
import { registerHealthRoutes } from "./modules/health/health.routes.js";

export interface GatewayContainer {
  config: AppConfig;
  logger: Logger;
  prisma: ReturnType<typeof createPrismaClient>;
  redis: ReturnType<typeof createRedisClient>;
  applicationService: ApplicationService;
  providerManager: ProviderManager;
  providerService: ProviderService;
  usageService: UsageService;
  auditService: AuditService;
  otpService: OtpService;
  metrics: MetricsService;
}

export interface BuildAppOptions {
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}

export async function buildApp(options: BuildAppOptions = {}) {
  const env = parseConfig(options.env ?? process.env);
  const config = buildConfig(env);
  const logger = options.logger ?? createLogger(config.logLevel, config.env);
  const app = Fastify({
    loggerInstance: logger,
    requestIdHeader: "x-request-id",
    genReqId: (request) => {
      const incoming = request.headers["x-request-id"];
      const value = Array.isArray(incoming) ? incoming[0] : incoming;
      return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : randomUUID();
    },
    trustProxy: config.env === "production",
  });

  app.decorateRequest("application", undefined);
  app.decorateRequest("correlationId", "");
  app.addHook("onRequest", async (request) => {
    request.correlationId = request.id;
  });

  await app.register(cors, {
    origin: config.corsOrigins.length === 1 && config.corsOrigins[0] === "*" ? true : config.corsOrigins,
    credentials: false,
  });
  await app.register(helmet, { global: true });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Central OTP & SMS Gateway",
        description: "Reusable multi-application OTP and SMS delivery gateway",
        version: "1.0.0",
      },
      servers: [{ url: "http://localhost:3000", description: "Local development" }],
      tags: [
        { name: "OTP", description: "Application-scoped OTP operations" },
        { name: "Admin", description: "Administrative operations" },
        { name: "Admin Applications", description: "Application management" },
        { name: "Admin Providers", description: "SMS provider management" },
        { name: "Admin Usage", description: "Usage, cost and reports" },
        { name: "Health", description: "Service health probes" },
      ],
      components: {
        securitySchemes: {
          applicationApiKey: {
            type: "apiKey",
            in: "header",
            name: "X-API-Key",
            description: "Use together with X-API-Secret",
          },
          adminBearer: { type: "http", scheme: "bearer", bearerFormat: "token" },
        },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  const prisma = createPrismaClient(logger);
  const redis = createRedisClient(env.REDIS_URL);
  const store = new RedisStore(redis);
  const encryption = new EncryptionService(env.MASTER_KEY);
  const metrics = new MetricsService();
  const applicationService = new ApplicationService(prisma);
  const usageService = new UsageService(prisma);
  const auditService = new AuditService(prisma);
  const providerManager = new ProviderManager(
    prisma,
    store,
    encryption,
    { maxProviderFailover: config.failover.maxProviderFailover },
    {
      failureThreshold: config.failover.circuitBreakerThreshold,
      cooldownSeconds: config.failover.circuitBreakerCooldownSeconds,
    },
    logger,
  );
  setProviderFailureMetric(async (providerId) => metrics.providerFailure(providerId));
  const providerService = new ProviderService(prisma, encryption, providerManager);
  const rateLimiter = new RateLimitService(store, {
    ipPerMinute: config.rateLimits.ipPerMinute,
    appPerMinute: config.rateLimits.appPerMinute,
    phonePer10Minutes: config.rateLimits.phonePer10Minutes,
    resendCooldownSeconds: config.otp.resendCooldownSeconds,
  });
  const quotaService = new QuotaService(store);
  const idempotency = new IdempotencyService(store, config.idempotencyTtlSeconds);
  const otpService = new OtpService(
    store,
    config.otp,
    env.MASTER_KEY,
    new PrismaOtpRepository(prisma),
    providerManager,
    rateLimiter,
    quotaService,
    logger,
    {
      getRateLimitConfigs: () => prisma.rateLimitConfig.findMany({ select: { key: true, scope: true, limit: true, windowSeconds: true, enabled: true } }),
      getQuotas: (applicationId) => applicationService.getQuotas(applicationId),
      recordUsage: (input) => usageService.record(input),
      idempotency,
      metrics,
    },
  );
  otpService.setDefaultCountry(config.defaultCountry);
  const adminAuth = createAdminAuthenticator(env.ADMIN_TOKEN);

  const container: GatewayContainer = {
    config,
    logger,
    prisma,
    redis,
    applicationService,
    providerManager,
    providerService,
    usageService,
    auditService,
    otpService,
    metrics,
  };

  const routeApp = app as unknown as FastifyInstance;
  registerHealthRoutes(routeApp, { prisma, redis, providers: providerManager });
  registerOtpRoutes(routeApp, { otpService, applicationService });
  registerApplicationRoutes(routeApp, { applicationService, audit: auditService, adminAuth });
  registerProviderRoutes(routeApp, { providerService, audit: auditService, adminAuth });
  registerUsageRoutes(routeApp, { usage: usageService, audit: auditService, adminAuth });
  registerAdminRoutes(routeApp, { prisma, redis, providers: providerManager, usage: usageService, audit: auditService, adminAuth });

  app.get("/metrics", { schema: { tags: ["Health"], summary: "Prometheus metrics" } }, async (_request, reply) => {
    reply.header("content-type", metrics.registry.contentType);
    return reply.send(await metrics.metrics());
  });

  app.get("/", { schema: { tags: ["Health"], summary: "Gateway metadata" } }, async (_request, reply) => {
    return reply.send({ name: "Central OTP & SMS Gateway", version: "1.0.0", docs: "/docs" });
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send({
      error: { code: ERROR_CODES.NOT_FOUND, message: "Route not found", request_id: request.correlationId },
    });
  });

  app.setErrorHandler((error: any, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          request_id: request.correlationId,
          ...(error.details ? { details: error.details } : {}),
        },
      });
    }
    if (error.validation) {
      return reply.code(400).send({
        error: {
          code: ERROR_CODES.VALIDATION_ERROR,
          message: "Request validation failed",
          request_id: request.correlationId,
          details: error.validation,
        },
      });
    }
    logger.error({ err: error, request_id: request.correlationId }, "Unhandled request error");
    return reply.code(500).send({
      error: { code: ERROR_CODES.INTERNAL_ERROR, message: "Internal server error", request_id: request.correlationId },
    });
  });

  return { app, container };
}

