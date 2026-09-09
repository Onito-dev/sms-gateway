import type { AdapterFactory, AdapterParamSchema, ProviderParamField } from "./provider.interface.js";
import { mockAdapterFactory, MOCK_PARAMS } from "./adapters/mock.provider.js";
import { genericHttpAdapterFactory, GENERIC_HTTP_PARAMS } from "./adapters/generic-http.provider.js";
import { kavenegarAdapterFactory, KAVENEGAR_PARAMS } from "./adapters/kavenegar.provider.js";
import { smsIrAdapterFactory, SMSIR_PARAMS } from "./adapters/smsir.provider.js";

/**
 * Registry of adapter definitions. Each SMS company has a different API
 * structure — the adapter code owns that structure, while its `params`
 * declare the editable parameters (api key, template id, …) that admins
 * configure per provider row and that are stored in the database
 * (credentials encrypted, config as JSON).
 *
 * Adding a new SMS provider =
 * 1. write one adapter file implementing SmsProviderAdapter
 * 2. register its factory + parameter fields here
 * 3. create a provider row with that `type` — no OTP core changes needed.
 */
interface AdapterDefinition {
  factory: AdapterFactory;
  params: ProviderParamField[];
}

const registry = new Map<string, AdapterDefinition>();

export function registerAdapter(type: string, factory: AdapterFactory, params: ProviderParamField[] = []): void {
  registry.set(type.toUpperCase(), { factory, params });
}

export function getAdapter(type: string): AdapterFactory | undefined {
  return registry.get(type.toUpperCase())?.factory;
}

/** Declarative parameter schema for an adapter type (empty for unknown). */
export function getParamSchema(type: string): AdapterParamSchema {
  return { fields: registry.get(type.toUpperCase())?.params ?? [] };
}

export function listAdapterTypes(): string[] {
  return [...registry.keys()];
}

registerAdapter("MOCK", mockAdapterFactory, MOCK_PARAMS);
registerAdapter("GENERIC_HTTP", genericHttpAdapterFactory, GENERIC_HTTP_PARAMS);
registerAdapter("KAVENEGAR", kavenegarAdapterFactory, KAVENEGAR_PARAMS);
registerAdapter("SMSIR", smsIrAdapterFactory, SMSIR_PARAMS);
