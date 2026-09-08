import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { parseQuery, optionalDate } from "../../common/route-helpers.js";
import type { AuditService } from "../admin/audit.service.js";
import type { UsageService } from "./usage.service.js";

const querySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  applicationId: z.string().optional(),
  providerId: z.string().optional(),
  status: z.enum(["SUCCESS", "FAILED", "REJECTED", "RATE_LIMITED", "QUOTA_EXCEEDED"]).optional(),
  country: z.string().length(2).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export function registerUsageRoutes(
  app: FastifyInstance,
  deps: { usage: UsageService; audit: AuditService; adminAuth: preHandlerHookHandler },
): void {
  const preHandler = deps.adminAuth;
  app.get("/api/v1/admin/usage", { preHandler, schema: { tags: ["Admin Usage"], summary: "List usage events" } }, async (request, reply) => {
    const query = parseQuery(querySchema, request.query);
    return reply.send(await deps.usage.list({
      from: optionalDate(query.from),
      to: optionalDate(query.to),
      applicationId: query.applicationId,
      providerId: query.providerId,
      status: query.status,
      country: query.country,
      limit: query.limit,
      offset: query.offset,
    }));
  });

  app.get("/api/v1/admin/reports/summary", { preHandler, schema: { tags: ["Admin Usage"], summary: "Get usage and cost report" } }, async (request, reply) => {
    const query = parseQuery(querySchema, request.query);
    return reply.send(await deps.usage.summary({
      from: optionalDate(query.from),
      to: optionalDate(query.to),
      applicationId: query.applicationId,
      providerId: query.providerId,
      status: query.status,
      country: query.country,
    }));
  });

  app.get("/api/v1/admin/audit-logs", { preHandler, schema: { tags: ["Admin Audit"], summary: "List audit logs" } }, async (request, reply) => {
    const query = request.query as { limit?: string; offset?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 100) || 100, 1), 200);
    const offset = Math.max(Number(query.offset ?? 0) || 0, 0);
    return reply.send(await deps.audit.list(limit, offset));
  });
}
