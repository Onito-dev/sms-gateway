import { AppError } from "../../common/errors.js";
import type { ProviderParamField } from "./provider.interface.js";
import { getParamSchema, listAdapterTypes } from "./provider.registry.js";

export interface ProviderParamsInput {
  credentials?: Record<string, string>;
  config?: Record<string, unknown>;
}

/**
 * Validate a provider's credentials/config against the adapter's declared
 * parameter fields. Runs on admin create/update so misconfiguration is
 * caught at save time — not discovered at send time on production.
 *
 * Unknown keys are rejected (they are how `apikey` vs `apiKey` typos
 * silently break delivery); known-but-optional absent keys are fine.
 */
export function validateProviderParams(
  type: string,
  input: ProviderParamsInput,
  mode: "create" | "update",
): void {
  const { fields } = getParamSchema(type);
  if (fields.length === 0) return; // Unknown/custom types: no declared schema.

  const credentials = input.credentials ?? {};
  const config = input.config ?? {};

  for (const field of fields) {
    const group = field.group === "credentials" ? credentials : config;
    const present = Object.prototype.hasOwnProperty.call(group, field.name);
    const raw = group[field.name];

    if (!present || raw === undefined || raw === null || raw === "") {
      // Update flows may omit fields (e.g. secrets are write-only).
      if (mode === "update") continue;
      if (field.required) {
        throw AppError.validation(`Provider parameter '${field.name}' is required for type ${type} (${field.label}).`);
      }
      continue;
    }

    validateValue(field, raw, type);
  }

  // Unknown keys in either group are rejected — a typo'd key would otherwise
  // be silently stored and the adapter would run with its defaults/fail.
  rejectUnknownKeys(fields, credentials, config, type);
}

/**
 * Validate a merged (existing + incoming) config object: enforces required
 * fields and value formats, but tolerates unknown legacy keys already in DB.
 */
export function validateMergedConfig(type: string, config: Record<string, unknown>): void {
  const { fields } = getParamSchema(type);
  if (fields.length === 0) return;
  for (const field of fields) {
    if (field.group !== "config" || !field.required) continue;
    const raw = config[field.name];
    if (raw === undefined || raw === null || raw === "") {
      throw AppError.validation(`Provider parameter '${field.name}' is required for type ${type} (${field.label}).`);
    }
    validateValue(field, raw, type);
  }
}

function validateValue(field: ProviderParamField, raw: unknown, type: string): void {
  const label = `${type}.${field.name}`;

  if (field.kind === "number") {
    const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw AppError.validation(`Provider parameter '${label}' must be a number.`);
    }
    if (field.integer && !Number.isInteger(value)) {
      throw AppError.validation(`Provider parameter '${label}' must be an integer.`);
    }
    if (field.min !== undefined && value < field.min) {
      throw AppError.validation(`Provider parameter '${label}' must be >= ${field.min}.`);
    }
    if (field.max !== undefined && value > field.max) {
      throw AppError.validation(`Provider parameter '${label}' must be <= ${field.max}.`);
    }
    return;
  }

  if (field.kind === "boolean") {
    if (typeof raw === "boolean") return;
    if (raw === "true" || raw === "false") return;
    throw AppError.validation(`Provider parameter '${label}' must be a boolean.`);
  }

  if (field.kind === "select") {
    if (typeof raw !== "string" || !field.options?.includes(raw)) {
      throw AppError.validation(`Provider parameter '${label}' must be one of: ${(field.options ?? []).join(", ")}.`);
    }
    return;
  }

  // kind === "string"
  if (typeof raw !== "string") {
    throw AppError.validation(`Provider parameter '${label}' must be a string.`);
  }
  const value = raw;
  if (field.minLength !== undefined && value.length < field.minLength) {
    throw AppError.validation(`Provider parameter '${label}' must be at least ${field.minLength} characters.`);
  }
  if (field.maxLength !== undefined && value.length > field.maxLength) {
    throw AppError.validation(`Provider parameter '${label}' must be at most ${field.maxLength} characters.`);
  }
  if (field.pattern && !new RegExp(field.pattern).test(value)) {
    throw AppError.validation(`Provider parameter '${label}' has an invalid format.`);
  }
}

function rejectUnknownKeys(
  fields: ProviderParamField[],
  credentials: Record<string, unknown>,
  config: Record<string, unknown>,
  type: string,
): void {
  const credentialKeys = new Set(fields.filter((f) => f.group === "credentials").map((f) => f.name));
  const configKeys = new Set(fields.filter((f) => f.group === "config").map((f) => f.name));
  for (const key of Object.keys(credentials)) {
    if (!credentialKeys.has(key)) {
      throw AppError.validation(`Unknown credential parameter '${key}' for provider type ${type}. Expected: ${[...credentialKeys].join(", ") || "none"}.`);
    }
  }
  for (const key of Object.keys(config)) {
    if (!configKeys.has(key)) {
      throw AppError.validation(`Unknown config parameter '${key}' for provider type ${type}. Expected: ${[...configKeys].join(", ") || "none"}.`);
    }
  }
}
