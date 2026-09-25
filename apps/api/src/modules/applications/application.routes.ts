import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { AppError } from "../../common/errors.js";
import { parseBody, zodJsonSchema } from "../../common/route-helpers.js";
import type { AuditService } from "../admin/audit.service.js";
import type { ApplicationService } from "./application.service.js";

const policy = z.object({
  length: z.number().int().min(4).max(12).optional(),
  ttlSeconds: z.number().int().min(30).max(3600).optional(),
  maxAttempts: z.number().int().min(1).max(20).optional(),
  resendCooldownSeconds: z.number().int().min(0).max(3600).optional(),
});
const rateLimits = z.record(z.string(), z.number().int().nonnegative().max(1000000));
const quotas = z.record(z.enum(["DAILY_SMS", "MONTHLY_SMS", "DAILY_COST_USD", "MONTHLY_COST_USD"]), z.number().nonnegative());
const createBody = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z.string().trim().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().max(1000).optional(),
  allowedCountries: z.array(z.string().regex(/^(?:[A-Za-z]{2}|\*)$/)).min(1).optional(),
  otpPolicy: policy.optional(),
  rateLimits: rateLimits.optional(),
  providerStrategy: z.enum(["PRIORITY", "CHEAPEST", "WEIGHTED", "AUTO"]).optional(),
  quotas: quotas.optional(),
});
const updateBody = createBody.omit({ slug: true, quotas: true }).partial().extend({
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
});
const quotaPatch = z.object({ limit: z.number().nonnegative().max(1000000000), enabled: z.boolean().optional() });

function idParam(value: unknown): string {
  const parsed = z.string().cuid().safeParse(value);
  if (!parsed.success) throw AppError.validation("Application id must be a valid id");
  return parsed.data;
}

export function registerApplicationRoutes(    app: FastifyInstance,
  deps: { applicationService: ApplicationService; audit: AuditService; adminAuth: preHandlerHookHandler },
): void {
  const preHandler = deps.adminAuth;

  app.get("/api/v1/admin/applications", { preHandler, schema: { tags: ["Admin Applications"], summary: "List applications" } }, async (_request, reply) => {
    return reply.send({ items: await deps.applicationService.list() });
  });

  app.post("/api/v1/admin/applications", {
    preHandler,
    schema: { tags: ["Admin Applications"], summary: "Create an application", body: zodJsonSchema(createBody) },
  }, async (request, reply) => {
    const body = parseBody(createBody, request.body);
    const result = await deps.applicationService.create(body);
    await deps.audit.record({ actor: "admin", action: "application.created", resource: "application", resourceId: result.application.id, ip: request.ip, metadata: { slug: result.application.slug } });
    // The secret is deliberately returned only in this create/rotate response.
    return reply.code(201).send(result);
  });

  app.get("/api/v1/admin/applications/:id", { preHandler, schema: { tags: ["Admin Applications"], summary: "Get an application" } }, async (request, reply) => {
    const id = idParam((request.params as { id?: unknown }).id);
    return reply.send(await deps.applicationService.get(id));
  });

  app.patch("/api/v1/admin/applications/:id", {
    preHandler,
    schema: { tags: ["Admin Applications"], summary: "Update an application", body: zodJsonSchema(updateBody) },
  }, async (request, reply) => {
    const id = idParam((request.params as { id?: unknown }).id);
    const body = parseBody(updateBody, request.body);
    const result = await deps.applicationService.update(id, body);
    await deps.audit.record({ actor: "admin", action: "application.updated", resource: "application", resourceId: id, ip: request.ip, metadata: { fields: Object.keys(body) } });
    return reply.send(result);
  });

  app.delete("/api/v1/admin/applications/:id", { preHandler, schema: { tags: ["Admin Applications"], summary: "Delete an application" } }, async (request, reply) => {
    const id = idParam((request.params as { id?: unknown }).id);
    await deps.applicationService.remove(id);
    await deps.audit.record({ actor: "admin", action: "application.deleted", resource: "application", resourceId: id, ip: request.ip });
    return reply.code(204).send();
  });

  app.post("/api/v1/admin/applications/:id/rotate-credentials", { preHandler, schema: { tags: ["Admin Applications"], summary: "Rotate application credentials" } }, async (request, reply) => {
    const id = idParam((request.params as { id?: unknown }).id);
    const credentials = await deps.applicationService.rotateCredentials(id);
    // The rotation is already committed and the previous keys are revoked, so a
    // failed audit write must never hide the new secret from the caller: log it
    // loudly and still return the credentials.
    await deps.audit
      .record({ actor: "admin", action: "application.credentials_rotated", resource: "application", resourceId: id, applicationId: id, ip: request.ip })
      .catch((err: unknown) => {
        request.log.error({ err, applicationId: id }, "Failed to record credential rotation in the audit log");
      });
    return reply.send(credentials);
  });

  app.post("/api/v1/admin/applications/:id/credentials", { preHandler, schema: { tags: ["Admin Applications"], summary: "Create an additional API key for an application" } }, async (request, reply) => {
    const id = idParam((request.params as { id?: unknown }).id);
    await deps.applicationService.get(id);
    const credentials = await deps.applicationService.createCredential(id);
    await deps.audit.record({ actor: "admin", action: "application.credential_created", resource: "application_credential", resourceId: id, ip: request.ip });
    // The secret is deliberately returned only in this create/rotate response.
    return reply.code(201).send(credentials);
  });

  app.post("/api/v1/admin/applications/:id/credentials/:credentialId/revoke", { preHandler, schema: { tags: ["Admin Applications"], summary: "Revoke an application credential" } }, async (request, reply) => {
    const params = request.params as { id?: unknown; credentialId?: unknown };
    const id = idParam(params.id);
    const credentialId = idParam(params.credentialId);
    await deps.applicationService.revokeCredential(id, credentialId);
    await deps.audit.record({ actor: "admin", action: "application.credential_revoked", resource: "application_credential", resourceId: credentialId, applicationId: id, ip: request.ip });
    return reply.code(204).send();
  });

  app.get("/api/v1/admin/applications/:id/quotas", { preHandler, schema: { tags: ["Admin Quotas"], summary: "List application quotas" } }, async (request, reply) => {
    const id = idParam((request.params as { id?: unknown }).id);
    await deps.applicationService.get(id);
    return reply.send({ items: await deps.applicationService.prismaQuotas(id) });
  });

  app.patch("/api/v1/admin/quotas/:id", {
    preHandler,
    schema: { tags: ["Admin Quotas"], summary: "Update a quota", body: zodJsonSchema(quotaPatch) },
  }, async (request, reply) => {
    const quotaId = idParam((request.params as { id?: unknown }).id);
    const body = parseBody(quotaPatch, request.body);
    const quota = await deps.applicationService.updateQuota(quotaId, body.limit, body.enabled);
    await deps.audit.record({ actor: "admin", action: "quota.changed", resource: "quota", resourceId: quotaId, ip: request.ip, metadata: { limit: body.limit, enabled: body.enabled } });
    return reply.send(quota);
  });
}
