/**
 * The standard SMS provider interface. The OTP core never knows which
 * provider is used — it only talks to this abstraction via SmsGateway.
 */

export interface SendSmsParams {
  /** E.164 phone number */
  phone: string;
  /** Rendered message text (OTP template already substituted) */
  message: string;
  purpose?: string;
}

export type SendFailureKind = "TIMEOUT" | "CONNECTION" | "AUTH" | "REJECTED" | "UNKNOWN";

export type SendSmsResult =
  | { ok: true; providerMessageId?: string }
  | {
      ok: false;
      error: string;
      /**
       * true when it is safe to try another provider — i.e. we are confident
       * the provider did NOT definitively accept the message (timeout,
       * connection error, auth failure before submission, explicit rejection).
       */
      retryable: boolean;
      kind?: SendFailureKind;
    };

export interface ProviderHealth {
  status: "HEALTHY" | "DEGRADED" | "DOWN" | "UNKNOWN";
  detail?: string;
}

export interface SmsProviderAdapter {
  readonly type: string;
  sendSms(params: SendSmsParams): Promise<SendSmsResult>;
  getBalance?(): Promise<number>;
  healthCheck?(): Promise<ProviderHealth>;
}

/** Adapter-specific constructor inputs (already decrypted). */
export interface AdapterContext {
  providerId: string;
  name: string;
  timeoutMs: number;
  credentials: Record<string, string>;
  config: Record<string, unknown>;
}

export type AdapterFactory = (ctx: AdapterContext) => SmsProviderAdapter;

/**
 * Declarative description of one adapter parameter. Each SMS company has a
 * different structure — the adapter code owns the structure, while these
 * descriptors make every parameter (api key, template id, …) editable and
 * storable per provider row, with validation before anything is saved.
 */
export interface ProviderParamField {
  /** Key inside credentials (group="credentials") or config (group="config"). */
  name: string;
  group: "credentials" | "config";
  kind: "string" | "number" | "boolean" | "select";
  label: string;
  /** Required before a provider of this type can be saved/used. */
  required?: boolean;
  /** Secrets are write-only: never echoed back by the admin API. */
  secret?: boolean;
  /** Applied by the adapter when the key is absent (never injected into DB). */
  default?: string | number | boolean;
  /** Allowed values for kind="select". */
  options?: string[];
  min?: number;
  max?: number;
  integer?: boolean;
  /** Regex source for kind="string" values. */
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  placeholder?: string;
  description?: string;
}

export interface AdapterParamSchema {
  fields: ProviderParamField[];
}
