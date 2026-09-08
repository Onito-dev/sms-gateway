import type {
  AdapterContext,
  AdapterFactory,
  SendSmsParams,
  SendSmsResult,
  SmsProviderAdapter,
} from "../provider.interface.js";

/**
 * KAVENEGAR adapter (https://kavenegar.com) — example of a concrete provider.
 *
 * Credentials (decrypted): { apiKey: "..." }
 * Config: { template: "otp-template-name" } — an approved Verify template.
 *
 * Uses the Verify/Lookup endpoint, which sends a fixed template with token(s).
 */
export class KavenegarProvider implements SmsProviderAdapter {
  readonly type = "KAVENEGAR";
  private static readonly BASE = "https://api.kavenegar.com/v1";

  constructor(private readonly ctx: AdapterContext) {}

  async sendSms(params: SendSmsParams): Promise<SendSmsResult> {
    const apiKey = this.ctx.credentials.apiKey;
    if (!apiKey) {
      return { ok: false, error: "kavenegar: missing credentials.apiKey", retryable: false, kind: "REJECTED" };
    }

    // Kavenegar expects receptor without the leading "+" of E.164
    const receptor = params.phone.replace(/^\+/, "");
    const template = typeof this.ctx.config.template === "string" ? this.ctx.config.template : "";
    const token = this.extractCode(params.message);

    const url = new URL(`${KavenegarProvider.BASE}/${apiKey}/verify/lookup.json`);
    url.searchParams.set("receptor", receptor);
    url.searchParams.set("token", token);
    url.searchParams.set("template", template);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.ctx.timeoutMs);

    try {
      const response = await fetch(url, { method: "POST", signal: controller.signal });
      const body = (await response.json().catch(() => null)) as {
        return?: { status?: number; message?: string };
        entries?: Array<{ messageid?: number }>;
      } | null;

      const status = body?.return?.status ?? response.status;
      if (response.status === 401 || status === 401) {
        return { ok: false, error: "kavenegar: auth failed", retryable: false, kind: "AUTH" };
      }
      if (status === 200 && response.ok) {
        return { ok: true, providerMessageId: body?.entries?.[0]?.messageid?.toString() };
      }
      if (response.status >= 500) {
        return { ok: false, error: `kavenegar: server error (${response.status})`, retryable: false, kind: "UNKNOWN" };
      }
      return { ok: false, error: `kavenegar: ${body?.return?.message ?? `rejected (${status})`}`, retryable: false, kind: "REJECTED" };
    } catch (err) {
      const e = err as Error & { code?: string; name?: string };
      if (e.name === "AbortError") {
        return { ok: false, error: "kavenegar: timeout", retryable: true, kind: "TIMEOUT" };
      }
      if (e.code === "ECONNREFUSED" || e.code === "ECONNRESET" || e.code === "ENOTFOUND" || e.code === "ETIMEDOUT") {
        return { ok: false, error: `kavenegar: connection error (${e.code})`, retryable: true, kind: "CONNECTION" };
      }
      return { ok: false, error: `kavenegar: ${e.message}`, retryable: false, kind: "UNKNOWN" };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The OTP service sends the rendered template; for Kavenegar we need the raw code as token. */
  private extractCode(message: string): string {
    const match = message.match(/\b(\d{4,8})\b/);
    return match?.[1] ?? message.slice(0, 20);
  }
}

export const kavenegarAdapterFactory: AdapterFactory = (ctx) => new KavenegarProvider(ctx);
