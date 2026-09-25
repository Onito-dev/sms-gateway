import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, type GatewayContainer } from "../src/app.js";
import { createLogger } from "../src/infrastructure/logging/logger.js";

/**
 * Route-level regression tests. They boot the real app, which is the point:
 * they cover the content-type parsing, onRequest hook and error-handler wiring
 * of app.ts. No database or Redis query is reached — every request below fails
 * earlier (in the body parser or in authentication).
 */
const env: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://gateway:gateway@127.0.0.1:5432/otp_gateway?schema=public",
  REDIS_URL: "redis://127.0.0.1:6399",
  MASTER_KEY: "test-master-key-0123456789abcdefghijklmnop",
  ADMIN_TOKEN: "test-admin-token-0123456789",
};

/** Shape of a Prisma `@default(cuid())` id, so the param validator accepts it. */
const APPLICATION_ID = "clx0aaabbb0000abcd1234efgh";

describe("admin application routes", () => {
  let app: FastifyInstance | undefined;
  let container: GatewayContainer | undefined;

  const boot = async () => {
    const built = await buildApp({ env, logger: createLogger("silent", "test") });
    built.container.redis.on("error", () => undefined); // unit tests run without Redis
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

  it("accepts a bodyless POST that still declares a JSON content type", async () => {
    // The admin panel used to send `content-type: application/json` on
    // rotate-credentials (and on key create/revoke and provider force-disable).
    // Fastify rejected the empty payload with FST_ERR_CTP_EMPTY_JSON_BODY
    // before the route handler — and even before the admin token check — ran.
    const server = await boot();

    const response = await server.inject({
      method: "POST",
      url: `/api/v1/admin/applications/${APPLICATION_ID}/rotate-credentials`,
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });

  it("reports a malformed JSON body as 400 instead of masking it as 500", async () => {
    const server = await boot();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/admin/applications",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-admin-token-0123456789",
      },
      payload: '{"name":',
    });

    expect(response.statusCode).toBe(400);
    // Fastify's own client error is surfaced (FST_ERR_CTP_INVALID_JSON_BODY)
    // instead of being rewritten as an opaque 500 INTERNAL_ERROR.
    expect(response.json().error.message).toMatch(/JSON/i);
    expect(response.json().error.code).not.toBe("INTERNAL_ERROR");
  });
});
