import type { AdapterFactory } from "./provider.interface.js";
import { mockAdapterFactory } from "./adapters/mock.provider.js";
import { genericHttpAdapterFactory } from "./adapters/generic-http.provider.js";
import { kavenegarAdapterFactory } from "./adapters/kavenegar.provider.js";
import { smsIrAdapterFactory } from "./adapters/smsir.provider.js";

/**
 * Registry of adapter factories. Adding a new SMS provider =
 * 1. write one adapter file implementing SmsProviderAdapter
 * 2. register its factory here
 * 3. create a provider row with that `type` — no OTP core changes needed.
 */
const registry = new Map<string, AdapterFactory>();

export function registerAdapter(type: string, factory: AdapterFactory): void {
  registry.set(type.toUpperCase(), factory);
}

export function getAdapter(type: string): AdapterFactory | undefined {
  return registry.get(type.toUpperCase());
}

export function listAdapterTypes(): string[] {
  return [...registry.keys()];
}

registerAdapter("MOCK", mockAdapterFactory);
registerAdapter("GENERIC_HTTP", genericHttpAdapterFactory);
registerAdapter("KAVENEGAR", kavenegarAdapterFactory);
registerAdapter("SMSIR", smsIrAdapterFactory);
