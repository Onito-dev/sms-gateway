import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, type GatewayContainer } from "../src/app.js";
import { createLogger } from "../src/infrastructure/logging/logger.js";

/**
 * CORS setting tests. They boot the real app and exercise the dynamic origin
 * resolver registered in app.ts. The database is unreachable in unit tests,
 * which is exactly the fallback path that must keep working.
 */
const env: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://gateway:gateway@127.0.0.1:5432/otp_gateway?schema=public",
  REDIS_URL: "redis://127.0.0.1:6399",
  MASTER_KEY: "test-master-key-0123456789abcdefghijklmnop",
  ADMIN_TOKEN: "test-admin-token-0123456789",
  CORS_ORIGINS: "https://env.example,http://localhost:5173",
};


describe("dynamic CORS origins", () => {
  let app: FastifyInstance | undefined;
  let container: GatewayContainer | undefined;

  const boot = async () => {
    const built = await buildApp({ env, logger: createLogger("silent", "test") });
    built.container.redis.on("error", () => undefined);
    await built.app.ready();
    app = built.app;
    container = built.container;
    return built.app;
  };

  afterEach(async () => {
    await app?.close();
    container?.redis.disconnect();
    app = undefined;
    container = undefined;
  });

  const inject = (app: FastifyInstance, origin?: string) =>
    app.inject({
      method: "GET",
      url: "/health",
      ...(origin ? { headers: { origin } } : {}),
    });

  it("falls back to the env origins while the setting store is unreachable", async () => {
    const server = await boot();
    const allowed = await inject(server, "https://env.example");
    const denied = await inject(server, "https://evil.example");

    expect(allowed.headers["access-control-allow-origin"]).toBe("https://env.example");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers preflights for allowed origins only", async () => {
    const server = await boot();
    const allowed = await server.inject({
      method: "OPTIONS",
      url: "/api/v1/otp/request",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "POST",
      },
    });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:5173");

    const denied = await server.inject({
      method: "OPTIONS",
      url: "/api/v1/otp/request",
      headers: {
        origin: "https://evil.example",
        "access-control-request-method": "POST",
      },
    });
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("requires an exact origin match including scheme and port", async () => {
    const server = await boot();
    const wrongPort = await inject(server, "https://env.example:8443");
    const wrongScheme = await inject(server, "http://env.example");
    expect(wrongPort.headers["access-control-allow-origin"]).toBeUndefined();
    expect(wrongScheme.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("reflects any origin when configured as *", async () => {
    const built = await buildApp({
      env: { ...env, CORS_ORIGINS: "*" },
      logger: createLogger("silent", "test"),
    });
    built.container.redis.on("error", () => undefined);
    await built.app.ready();
    try {
      const response = await inject(built.app, "https://anything.example");
      expect(response.headers["access-control-allow-origin"]).toBe("https://anything.example");
    } finally {
      await built.app.close();
      built.container.redis.disconnect();
    }
  });

  it("guards the CORS origins setting behind admin authentication", async () => {
    const server = await boot();

    const unauthenticated = await server.inject({
      method: "GET",
      url: "/api/v1/admin/settings/cors-origins",
    });
    expect(unauthenticated.statusCode).toBe(401);

    const unauthenticatedPatch = await server.inject({
      method: "PATCH",
      url: "/api/v1/admin/settings/cors-origins",
      headers: { "content-type": "application/json" },
      payload: { allowedOrigins: ["https://evil.example"] },
    });
    expect(unauthenticatedPatch.statusCode).toBe(401);
  });
});
