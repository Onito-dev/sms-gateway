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
