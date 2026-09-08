import type {
  AdapterContext,
  AdapterFactory,
  SendSmsParams,
  SendSmsResult,
  SmsProviderAdapter,
} from "../provider.interface.js";

const retryableKind = (err: unknown): { retryable: boolean; kind: "TIMEOUT" | "CONNECTION" | "UNKNOWN" } => {
  const e = err as { name?: string; code?: string };
  if (e?.name === "AbortError" || e?.name === "TimeoutError") {
    return { retryable: true, kind: "TIMEOUT" };
  }
  if (e?.code === "ECONNREFUSED" || e?.code === "ECONNRESET" || e?.code === "ENOTFOUND" || e?.code === "ETIMEDOUT") {
    return { retryable: true, kind: "CONNECTION" };
  }
  return { retryable: false, kind: "UNKNOWN" };
};

/**
 * GENERIC_HTTP adapter — works with any SMS gateway exposing a simple JSON API.
 *
 * Config:
 *   url:              "https://provider.example/api/sms/send"
 *   method:           "POST" (default)
 *   sender:           "GATEWAY" (optional sender name/id)
 *   messageTemplate:  "{{code}} is your verification code" (optional; the OTP
 *                     service already renders the message, this is a fallback)
 *
 * Credentials (decrypted):
 *   apiKey / apiToken / username / password — sent as headers:
 *   X-API-Key: <apiKey>   and/or   Authorization: Bearer <apiToken>
 *
 * The provider must accept JSON { phone, message, sender } and respond 2xx.
 */
export class GenericHttpProvider implements SmsProviderAdapter {
  readonly type = "GENERIC_HTTP";

  constructor(private readonly ctx: AdapterContext) {}

  async sendSms(params: SendSmsParams): Promise<SendSmsResult> {
    const url = this.ctx.config.url;
    if (typeof url !== "string" || url.length === 0) {
      return { ok: false, error: "generic-http: missing config.url", retryable: false, kind: "REJECTED" };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.ctx.timeoutMs);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.ctx.credentials.apiKey) headers["x-api-key"] = this.ctx.credentials.apiKey;
    if (this.ctx.credentials.apiToken) headers["authorization"] = `Bearer ${this.ctx.credentials.apiToken}`;

    try {
      const response = await fetch(url, {
        method: typeof this.ctx.config.method === "string" ? this.ctx.config.method : "POST",
        headers,
        body: JSON.stringify({
          phone: params.phone,
          message: params.message,
          sender: this.ctx.config.sender ?? null,
          purpose: params.purpose ?? null,
        }),
        signal: controller.signal,
      });

      if (response.status === 401 || response.status === 403) {
        return { ok: false, error: `generic-http: auth failed (${response.status})`, retryable: false, kind: "AUTH" };
      }
      if (!response.ok) {
        // 4xx = definitive rejection (bad number, bad request) — do not retry elsewhere.
        if (response.status >= 400 && response.status < 500) {
          return { ok: false, error: `generic-http: rejected (${response.status})`, retryable: false, kind: "REJECTED" };
        }
        // 5xx = provider-side problem; the request may have been accepted.
        return { ok: false, error: `generic-http: server error (${response.status})`, retryable: false, kind: "UNKNOWN" };
      }
      const body = (await response.json().catch(() => null)) as { messageId?: string; id?: string } | null;
      return { ok: true, providerMessageId: body?.messageId ?? body?.id ?? undefined };
    } catch (err) {
      const kind = retryableKind(err);
      return { ok: false, error: `generic-http: ${(err as Error).message}`, ...kind };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const genericHttpAdapterFactory: AdapterFactory = (ctx) => new GenericHttpProvider(ctx);
