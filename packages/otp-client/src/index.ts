export interface OtpClientOptions {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  fetch?: typeof fetch;
}

export interface RequestOtpInput {
  phone: string;
  purpose: string;
  idempotencyKey?: string;
}

export interface RequestOtpResponse {
  request_id: string;
  expires_in: number;
  resend_after: number;
  replayed?: boolean;
}

export interface VerifyOtpInput {
  requestId: string;
  phone: string;
  code: string;
}

export interface VerifyOtpResponse {
  verified: boolean;
  error?: string;
}

export interface OtpRequestStatus {
  request_id: string;
  status: string;
  created_at: string;
  verified_at: string | null;
}

export interface GatewayErrorBody {
  error?: {
    code?: string;
    message?: string;
    request_id?: string;
    details?: unknown;
  };
}

export class OtpGatewayError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, requestId?: string, details?: unknown) {
    super(message);
    this.name = "OtpGatewayError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

/**
 * Dependency-free HTTP client for consuming applications.
 * The client never receives the OTP code; the gateway sends it by SMS.
 */
export class OtpClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly http: typeof fetch;

  constructor(options: OtpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.http = options.fetch ?? fetch;
  }

  async request(input: RequestOtpInput): Promise<RequestOtpResponse> {
    const headers: Record<string, string> = this.headers();
    if (input.idempotencyKey) headers["idempotency-key"] = input.idempotencyKey;
    return this.send<RequestOtpResponse>("/api/v1/otp/request", {
      method: "POST",
      headers,
      body: JSON.stringify({ phone: input.phone, purpose: input.purpose }),
    });
  }

  async verify(input: VerifyOtpInput): Promise<VerifyOtpResponse> {
    return this.send<VerifyOtpResponse>("/api/v1/otp/verify", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ request_id: input.requestId, phone: input.phone, code: input.code }),
    });
  }

  async status(requestId: string): Promise<OtpRequestStatus> {
    return this.send<OtpRequestStatus>(`/api/v1/otp/requests/${encodeURIComponent(requestId)}`, {
      method: "GET",
      headers: this.headers(),
    });
  }

  private headers(): Record<string, string> {
    return {
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": this.apiKey,
      "x-api-secret": this.apiSecret,
    };
  }

  private async send<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.http(`${this.baseUrl}${path}`, init);
    const body = await response.json().catch(() => null) as T | GatewayErrorBody | null;
    if (!response.ok) {
      const error = body as GatewayErrorBody | null;
      throw new OtpGatewayError(
        response.status,
        error?.error?.code ?? "GATEWAY_ERROR",
        error?.error?.message ?? "OTP gateway request failed",
        error?.error?.request_id,
        error?.error?.details,
      );
    }
    return body as T;
  }
}

export default OtpClient;
