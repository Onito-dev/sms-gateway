import type {
  AdapterContext,
  AdapterFactory,
  SendSmsParams,
  SendSmsResult,
  SmsProviderAdapter,
} from "../provider.interface.js";

/**
 * SMS.IR adapter (https://sms.ir) — high-priority VERIFY send.
 *
 * Uses POST https://api.sms.ir/v1/send/verify with an approved template
 * defined in the sms.ir panel. The template contains a parameter (default
 * name "Code") whose value is substituted with the OTP.
 *
 * Credentials (decrypted): { apiKey: "..." }
 * Config:
 *   templateId:            123456            (required — from the sms.ir panel)
 *   codeParameter:         "Code"            (optional — parameter name in the template)
 *   mobileWithCountryCode: false             (optional — when true sends "989121234567"
 *                                            instead of the local "9121234567")
 *
 * API contract:
 *   body:  { mobile, templateId, parameters: [{ name, value }] }
 *   2xx + body.status === 1 → accepted, data.messageId returned
 *   anything else           → failure (AUTH for 401/403, REJECTED for other 4xx)
 */
export class SmsIrProvider implements SmsProviderAdapter {
  readonly type = "SMSIR";
  private static readonly BASE = "https://api.sms.ir/v1";

  constructor(private readonly ctx: AdapterContext) {}

  async sendSms(params: SendSmsParams): Promise<SendSmsResult> {
    const apiKey = this.ctx.credentials.apiKey;
    if (!apiKey) {
      return { ok: false, error: "smsir: missing credentials.apiKey", retryable: false, kind: "REJECTED" };
    }
    const templateId = typeof this.ctx.config.templateId === "number" ? this.ctx.config.templateId : Number(this.ctx.config.templateId);
    if (!Number.isInteger(templateId) || templateId <= 0) {
      return { ok: false, error: "smsir: config.templateId must be a positive integer (from the sms.ir panel)", retryable: false, kind: "REJECTED" };
    }

    const codeParameter = typeof this.ctx.config.codeParameter === "string" && this.ctx.config.codeParameter.length > 0
      ? this.ctx.config.codeParameter
      : "Code";
    const code = this.extractCode(params.message);
    const mobile = this.toMobile(params.phone);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.ctx.timeoutMs);

    try {
      const response = await fetch(`${SmsIrProvider.BASE}/send/verify`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "text/plain",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({
          mobile,
          templateId,
          parameters: [{ name: codeParameter, value: code }],
        }),
        signal: controller.signal,
      });

      const body = (await response.json().catch(() => null)) as {
        status?: number;
        message?: string;
        data?: { messageId?: number; cost?: number };
      } | null;

      if (response.status === 401 || response.status === 403) {
        return { ok: false, error: `smsir: auth failed (${response.status})`, retryable: false, kind: "AUTH" };
      }
      if (response.ok && body?.status === 1) {
        return { ok: true, providerMessageId: body.data?.messageId?.toString() };
      }
      const detail = body?.message ? `: ${body.message}` : "";
      if (response.status >= 400 && response.status < 500) {
        // Definitive client-side rejection (bad number, inactive template, no credit) —
        // the request was NOT accepted, but the error is not transient either.
        return { ok: false, error: `smsir: rejected (${response.status})${detail}`, retryable: false, kind: "REJECTED" };
      }
      if (response.status >= 500) {
        // Provider-side problem: the message may or may not have been queued.
        // Treated as UNKNOWN so the circuit breaker records it, but failover is
        // allowed only on timeout/connection per the failover policy.
        return { ok: false, error: `smsir: server error (${response.status})${detail}`, retryable: false, kind: "UNKNOWN" };
      }
      return { ok: false, error: `smsir: send failed (status ${body?.status ?? response.status})${detail}`, retryable: false, kind: "REJECTED" };
    } catch (err) {
      const e = err as Error & { code?: string; name?: string };
      if (e.name === "AbortError") {
        return { ok: false, error: "smsir: timeout", retryable: true, kind: "TIMEOUT" };
      }
      if (e.code === "ECONNREFUSED" || e.code === "ECONNRESET" || e.code === "ENOTFOUND" || e.code === "ETIMEDOUT") {
        return { ok: false, error: `smsir: connection error (${e.code})`, retryable: true, kind: "CONNECTION" };
      }
      return { ok: false, error: `smsir: ${e.message}`, retryable: false, kind: "UNKNOWN" };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * sms.ir expects the local mobile format without the leading zero
   * (e.g. "9121234567"). Config `mobileWithCountryCode: true` switches to
   * full E.164 digits without "+" (e.g. "989121234567").
   */
  private toMobile(phone: string): string {
    const digits = phone.replace(/^\+/, "").replace(/\D/g, "");
    if (this.ctx.config.mobileWithCountryCode === true) return digits;
    if (digits.startsWith("98") && digits.length > 10) return digits.slice(2);
    if (digits.startsWith("0")) return digits.slice(1);
    return digits;
  }

  /** The OTP service sends the rendered template; extract the raw code as parameter value. */
  private extractCode(message: string): string {
    const match = message.match(/\b(\d{4,8})\b/);
    return match?.[1] ?? message.slice(0, 25);
  }
}

export const smsIrAdapterFactory: AdapterFactory = (ctx) => new SmsIrProvider(ctx);
