import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { AppError } from "../../common/errors.js";
import { normalizePhone } from "../../common/phone.js";
import { parseBody, zodJsonSchema } from "../../common/route-helpers.js";
import type { AuditService } from "../admin/audit.service.js";
import type { ProviderService } from "./provider.service.js";

const credentials = z.record(z.string(), z.string().max(1000));
const providerBody = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.string().trim().min(1).max(50),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  priority: z.number().int().min(0).max(100000).optional(),
  weight: z.number().int().min(1).max(100000).optional(),
  costPerSms: z.number().nonnegative().max(1000000).optional(),
  credentials: credentials.optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  timeoutMs: z.number().int().min(100).max(120000).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  supportedCountries: z.array(z.string().regex(/^(?:[A-Za-z]{2}|\*)$/)).min(1).optional(),
});
const providerPatch = providerBody.partial();
const testBody = z.object({ phone: z.string().min(6).max(32), message: z.string().min(1).max(1000) });
const priceBody = z.object({
  pricePerSms: z.number().nonnegative().max(1000000),
  currency: z.string().regex(/^[A-Za-z]{3}$/).default("USD"),
  effectiveFrom: z.string().datetime().optional(),
});

function idParam(value: unknown): string {
  const parsed = z.string().cuid().safeParse(value);
  if (!parsed.success) throw AppError.validation("Provider id must be a valid id");
  return parsed.data;
}

export function registerProviderRoutes(
  app: FastifyInstance,
  deps: { providerService: ProviderService; audit: AuditService; adminAuth: preHandlerHookHandler },
): void {
  const preHandler = deps.adminAuth;

  app.get("/api/v1/admin/providers", { preHandler, schema: { tags: ["Admin Providers"], summary: "List SMS providers" } }, async (_request, reply) => {
    return reply.send({ items: await deps.providerService.list(), supportedTypes: deps.providerService.supportedTypes() });
  });

  app.post("/api/v1/admin/providers", {
    preHandler,
    schema: { tags: ["Admin Providers"], summary: "Create an SMS provider", body: zodJsonSchema(providerBody) },
  }, async (request, reply) => {
    const body = parseBody(providerBody, request.body);
    const provider = await deps.providerService.create(body);
    await deps.audit.record({ actor: "admin", action: "provider.created", resource: "provider", resourceId: provider.id, ip: request.ip, metadata: { type: provider.type, name: provider.name } });
    return reply.code(201).send(provider);
  });

  app.get("/api/v1/admin/providers/:id", { preHandler, schema: { tags: ["Admin Providers"], summary: "Get an SMS provider" } }, async (request, reply) => {
    const id = idParam((request.params as { id?: unknown }).id);
    return reply.send({ provider: await deps.providerService.get(id), health: await deps.providerService.health(id) });
  });

  app.patch("/api/v1/admin/providers/:id", {
    preHandler,
    schema: { tags: ["Admin Providers"], summary: "Update an SMS provider", body: zodJsonSchema(providerPatch) },
  }, async (request, reply) => {
    const id = idParam((request.params as { id?: unknown }).id);
    const body = parseBody(providerPatch, request.body);
    const provider = await deps.providerService.update(id, body);
    await deps.audit.record({ actor: "admin", action: "provider.updated", resource: "provider", resourceId: id, ip: request.ip, metadata: { fields: Object.keys(body).filter((key) => key !== "credentials") } });
    if (body.credentials) {
      await deps.audit.record({ actor: "admin", action: "provider.credentials_changed", resource: "provider", resourceId: id, ip: request.ip });
    }
    return reply.send(provider);
  });

  app.post("/api/v1/admin/providers/:id/force-disable", { preHandler, schema: { tags: ["Admin Providers"], summary: "Force disable a provider" } }, async (request, reply) => {
    const id = idParam((request.params as { id?: unknown }).id);
    const provider = await deps.providerService.forceDisable(id);
    await deps.audit.record({ actor: "admin", action: "provider.disabled", resource: "provider", resourceId: id, ip: request.ip, metadata: { force: true } });
    return reply.send(provider);
  });

  app.get("/api/v1/admin/providers/:id/prices", { preHandler, schema: { tags: ["Admin Providers"], summary: "List provider price history" } }, async (request, reply) => {
    const id = idParam((request.params as { id?: unknown }).id);
    return reply.send({ items: await deps.providerService.prices(id) });
  });

  app.post("/api/v1/admin/providers/:id/prices", {
    preHandler,
    schema: { tags: ["Admin Providers"], summary: "Add a provider price snapshot", body: zodJsonSchema(priceBody) },
  }, async (request, reply) => {
    const id = idParam((request.params as { id?: unknown }).id);
    const body = parseBody(priceBody, request.body);
    const price = await deps.providerService.addPrice(id, body.pricePerSms, body.currency, body.effectiveFrom ? new Date(body.effectiveFrom) : new Date());
    await deps.audit.record({ actor: "admin", action: "provider.price_changed", resource: "provider_price", resourceId: price.id, ip: request.ip, metadata: { providerId: id, currency: body.currency } });
    return reply.code(201).send(price);
  });

  app.get("/api/v1/admin/providers/:id/health", { preHandler, schema: { tags: ["Admin Providers"], summary: "Get provider circuit status" } }, async (request, reply) => {
    const id = idParam((request.params as { id?: unknown }).id);
    return reply.send(await deps.providerService.health(id));
  });

  app.post("/api/v1/admin/providers/:id/test", {
    preHandler,
    schema: { tags: ["Admin Providers"], summary: "Send a test SMS through one provider", body: zodJsonSchema(testBody) },
  }, async (request, reply) => {
    const id = idParam((request.params as { id?: unknown }).id);
    const body = parseBody(testBody, request.body);
    const normalized = normalizePhone(body.phone, "IR");
    const result = await deps.providerService.test(id, normalized.e164, body.message);
    await deps.audit.record({ actor: "admin", action: "provider.test_sms", resource: "provider", resourceId: id, ip: request.ip, metadata: { success: result.ok } });
    return reply.send(result);
  });
}
