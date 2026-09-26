import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
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
import { SettingsService, type CorsOriginCheck } from "./modules/settings/settings.service.js";
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
import { registerSettingsRoutes } from "./modules/settings/settings.routes.js";
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
  settingsService: SettingsService;
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

    // Clients sometimes declare `Content-Type: application/json` on requests
    // that carry no body (the admin panel did for rotate-credentials, key
    // creation/revocation and provider force-disable). Fastify's JSON parser
    // rejects such an empty payload with FST_ERR_CTP_EMPTY_JSON_BODY before
    // the route handler — and even before authentication — can run, so drop
    // the header whenever there is definitively no body to parse.
    const contentLength = request.headers["content-length"];
    const hasBody =
      (contentLength !== undefined && contentLength !== "0") ||
      request.headers["transfer-encoding"] !== undefined;
    if (!hasBody && request.headers["content-type"] !== undefined) {
      delete request.headers["content-type"];
    }
  });

  await app.register(cors, {
    origin: (requestOrigin, callback) => {
      void resolveCorsOriginCheck().then((check) => {
        if (check.kind === "allow_all") {
          // Reflect any origin (equivalent to the previous `*` behaviour).
          callback(null, true);
          return;
        }
        const requestOriginNormalized = requestOrigin ? normalizeOrigin(requestOrigin) : "";
        // False (not an error) so non-allowed origins get no CORS headers and
        // the browser blocks the response, without turning the request into a 500.
        callback(null, requestOriginNormalized !== "" && check.allowedOrigins.includes(requestOriginNormalized));
      }).catch((error) => callback(error as Error, false));
    },
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
  const settingsService = new SettingsService(prisma);
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

  // ---------------------------------------------------------------------------
  // Dynamic CORS: the allowed-origins list is editable from the admin panel and
  // stored in PostgreSQL (Setting: cors_origins). The env value is only the
  // bootstrap/seed default and the fallback when the database is unreachable.
  // ---------------------------------------------------------------------------
  const envAllowAllOrigins = config.corsOrigins.length === 1 && config.corsOrigins[0] === "*";
  const normalizeOrigin = (origin: string): string => {
    const lower = origin.toLowerCase();
    return lower.length > 1 && lower.endsWith("/") ? lower.slice(0, -1) : lower;
  };
  const envCorsOrigins = config.corsOrigins.map(normalizeOrigin);
  // Short-lived cache so OTP traffic does not hit the DB on every request,
  // while panel edits still take effect immediately.
  const CORS_SETTINGS_TTL_MS = 5_000;
  let corsSettingCache: { value: CorsOriginCheck; expiresAt: number } | null = null;
  const resolveCorsOriginCheck = async (): Promise<CorsOriginCheck> => {
    const now = Date.now();
    if (corsSettingCache && corsSettingCache.expiresAt > now) return corsSettingCache.value;
    try {
      const value = await settingsService.getCorsOriginCheck();
      // An unset setting means "not configured yet" — keep the env origins as
      // the effective list so a fresh deployment is not locked open or shut.
      const effective: CorsOriginCheck = value.kind === "list" && value.allowedOrigins.length === 0 && !envAllowAllOrigins
        ? { kind: "list", allowedOrigins: envCorsOrigins }
        : value;
      corsSettingCache = { value: effective, expiresAt: now + CORS_SETTINGS_TTL_MS };
      return effective;
    } catch (error) {
      // Database hiccup: serve the last known list (or the env list) instead of
      // failing every cross-origin request.
      const fallback: CorsOriginCheck = corsSettingCache?.value ??
        (envAllowAllOrigins ? { kind: "allow_all" } : { kind: "list", allowedOrigins: envCorsOrigins });
      logger.warn({ err: error }, "Failed to load CORS origins setting; using fallback list");
      return fallback;
    }
  };

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
    settingsService,
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
  registerSettingsRoutes(routeApp, { settings: settingsService, audit: auditService, adminAuth });

  app.get("/metrics", { schema: { tags: ["Health"], summary: "Prometheus metrics" } }, async (_request, reply) => {
    reply.header("content-type", metrics.registry.contentType);
    return reply.send(await metrics.metrics());
  });

  // Serve the built admin panel (apps/admin/dist) under /admin when it is present
  // in the image. Local dev keeps using the Vite dev server; this is the production path.
  const adminDist = resolve(dirname(fileURLToPath(import.meta.url)), "../../admin/dist");
  if (existsSync(adminDist)) {
    await app.register(fastifyStatic, {
      root: adminDist,
      prefix: "/admin/",
      wildcard: false,
      index: false,
    });
    // SPA fallback: any /admin/* path that is not a real file serves index.html.
    app.setNotFoundHandler((request, reply) => {
      const url = request.url ?? "/";
      if (url === "/admin" || url.startsWith("/admin/")) {
        const assetPath = url.slice("/admin/".length).split("?")[0] ?? "";
        const assetFile = resolve(adminDist, assetPath);
        if (assetPath !== "" && assetFile.startsWith(adminDist) && existsSync(assetFile)) {
          return reply.sendFile(assetPath);
        }
        return reply.type("text/html").sendFile("index.html");
      }
      return reply.code(404).send({
        error: { code: ERROR_CODES.NOT_FOUND, message: "Route not found", request_id: request.correlationId },
      });
    });
  }

  app.get("/admin", { schema: { tags: ["Health"], summary: "Redirect to admin panel" } }, async (_request, reply) => {
    return reply.redirect("/admin/");
  });

  app.get("/", { schema: { tags: ["Health"], summary: "Gateway metadata" } }, async (_request, reply) => {
    return reply.send({ name: "Central OTP & SMS Gateway", version: "1.0.0", docs: "/docs", ...(existsSync(adminDist) ? { admin: "/admin/" } : {}) });
  });

  if (!existsSync(adminDist)) {
    app.setNotFoundHandler((request, reply) => {
      return reply.code(404).send({
        error: { code: ERROR_CODES.NOT_FOUND, message: "Route not found", request_id: request.correlationId },
      });
    });
  }

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
    // Fastify's own client errors (empty or malformed JSON body, payload too
    // large, unsupported media type, ...) already carry a 4xx statusCode.
    // Report them as such instead of masking every one of them as a 500.
    if (typeof error?.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({
        error: {
          code: typeof error?.code === "string" ? error.code : ERROR_CODES.VALIDATION_ERROR,
          message: typeof error?.message === "string" ? error.message : "Bad request",
          request_id: request.correlationId,
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

