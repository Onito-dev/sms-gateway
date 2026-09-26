import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { AppError } from "../../common/errors.js";
import { parseBody, zodJsonSchema } from "../../common/route-helpers.js";
import type { AuditService } from "../admin/audit.service.js";
import { SETTING_KEYS, type CorsOriginsSetting, type SettingsService } from "./settings.service.js";

const originSchema = z
  .string()
  .trim()
  .regex(/^(\*|https?:\/\/[a-zA-Z0-9._~%-]+(?::\d{1,5})?)$/, "Origin must be * or scheme://host[:port]");

const corsOriginsBody = z.object({
  allowedOrigins: z.array(originSchema).min(1).max(50),
});

export function registerSettingsRoutes(
  app: FastifyInstance,
  deps: { settings: SettingsService; audit: AuditService; adminAuth: preHandlerHookHandler },
): void {
  const preHandler = deps.adminAuth;

  app.get("/api/v1/admin/settings/cors-origins", {
    preHandler,
    schema: { tags: ["Admin Settings"], summary: "Get the CORS allowed-origins setting" },
  }, async (_request, reply) => {
    const setting = await deps.settings.get<CorsOriginsSetting>(SETTING_KEYS.CORS_ORIGINS);
    return reply.send({
      allowedOrigins: setting?.allowedOrigins ?? [],
      // True when the panel has saved a value; false means the env default is in effect.
      configured: setting !== null,
    });
  });

  app.patch("/api/v1/admin/settings/cors-origins", {
    preHandler,
    schema: { tags: ["Admin Settings"], summary: "Update the CORS allowed-origins setting", body: zodJsonSchema(corsOriginsBody) },
  }, async (request, reply) => {
    const body = parseBody(corsOriginsBody, request.body);
    const saved = await deps.settings.set(SETTING_KEYS.CORS_ORIGINS, body) as CorsOriginsSetting;
    await deps.audit.record({
      actor: "admin",
      action: "settings.cors_origins_updated",
      resource: "setting",
      resourceId: SETTING_KEYS.CORS_ORIGINS,
      ip: request.ip,
      metadata: { allowedOrigins: saved.allowedOrigins },
    });
    return reply.send({ allowedOrigins: saved.allowedOrigins, configured: true });
  });
}
