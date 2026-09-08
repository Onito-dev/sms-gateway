import { z, type ZodType } from "zod";
import { AppError } from "./errors.js";

/**
 * Zod's JSON-schema conversion emits `exclusiveMinimum: true` for
 * `.positive()`, which is draft-06+ syntax. Fastify/AJV validates against
 * draft-07, where it must be numeric, so rewrite it to an inclusive
 * `minimum` (OTP inputs never rely on the zero boundary).
 */
function normalizeJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const fix = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(fix);
      return;
    }
    if (!node || typeof node !== "object") return;
    const object = node as Record<string, unknown>;
    if (object.exclusiveMinimum === true) {
      object.exclusiveMinimum = undefined;
      delete object.exclusiveMinimum;
      if (object.minimum === undefined) object.minimum = 1;
    }
    if (object.exclusiveMaximum === true) {
      object.exclusiveMaximum = undefined;
      delete object.exclusiveMaximum;
    }
    Object.values(object).forEach(fix);
  };
  fix(schema);
  return schema;
}

export function parseBody<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw AppError.validation("Request validation failed", result.error.issues);
  }
  return result.data;
}

export function parseQuery<T>(schema: ZodType<T>, value: unknown): T {
  return parseBody(schema, value);
}

export function optionalDate(value: unknown): Date | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw AppError.validation("Invalid date filter");
  return parsed;
}

export function asJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function zodJsonSchema(schema: ZodType<unknown>): Record<string, unknown> {
  try {
    const zod = z as typeof z & {
      toJSONSchema?: (schema: ZodType<unknown>, options?: Record<string, unknown>) => Record<string, unknown>;
    };
    return normalizeJsonSchema(zod.toJSONSchema?.(schema, { target: "openapi-3.0", unrepresentable: "any" }) ?? {});
  } catch {
    return {};
  }
}
