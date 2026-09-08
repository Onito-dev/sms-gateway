export interface ApiErrorBody {
  error?: { code?: string; message?: string; request_id?: string };
}

export interface Dashboard {
  today: { sms: number; costUsd: number; successRate: number };
  month: { sms: number; costUsd: number; successRate: number };
  activeApplications: number;
  activeProviders: number;
  providerHealth: Array<{
    id: string;
    name: string;
    type: string;
    status: string;
    healthStatus: string;
    failureCount: number;
    successCount: number;
    avgResponseMs: number;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    lastHealthCheckAt: string | null;
    circuitOpenUntil: string | null;
  }>;
  topApplications: Array<{ applicationId: string; name: string; sms: number; costUsd: number }>;
  topProviders: Array<{ providerId: string | null; name: string; sms: number; costUsd: number }>;
}

export interface Application {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: string;
  allowedCountries: string[];
  providerStrategy: string;
  credentials: Array<{ id: string; apiKey: string; status: string; lastUsedAt: string | null }>;
  quotas: Array<{ id: string; type: string; limit: string | number; enabled: boolean }>;
  _count?: { usageEvents: number; otpRequests: number };
}

export interface Provider {
  id: string;
  name: string;
  type: string;
  status: string;
  priority: number;
  weight: number;
  costPerSms: number;
  config: unknown;
  timeoutMs: number;
  maxRetries: number;
  supportedCountries: string[];
  healthStatus: string;
  successCount: number;
  failureCount: number;
  successRate: number;
  avgResponseMs: number;
  credentialsConfigured: boolean;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  circuitOpenUntil: string | null;
}

export interface UsageSummary {
  totalEvents: number;
  totalSms: number;
  successfulSms: number;
  failedSms: number;
  rejectedSms: number;
  rateLimitedSms: number;
  quotaExceededSms: number;
  successRate: number;
  totalCostUsd: number;
  byProvider: Array<{ providerId: string | null; providerName: string; sms: number; costUsd: number }>;
  byApplication: Array<{ applicationId: string; applicationName: string; sms: number; costUsd: number }>;
  byDay: Array<{ day: string; sms: number; cost: number; success: number; failed: number }>;
}

export interface UsageEvent {
  id: string;
  applicationId: string;
  providerId: string | null;
  otpRequestId: string | null;
  phoneCountry: string;
  smsCount: number;
  status: string;
  providerCost: string | number;
  latencyMs: number | null;
  error: string | null;
  createdAt: string;
  application?: { id: string; name: string; slug: string };
  provider?: { id: string; name: string; type: string } | null;
}

export interface RateLimitConfig {
  id: string;
  key: string;
  scope: string;
  limit: number;
  windowSeconds: number;
  enabled: boolean;
  description: string | null;
}

export interface AuditLog {
  id: string;
  actor: string;
  action: string;
  resource: string;
  resourceId: string | null;
  ip: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface SystemHealth {
  status: string;
  database: boolean;
  redis: boolean;
  providerHealth: Array<{ providerId: string; name: string; health: { status: string; circuitOpen: boolean; consecutiveFailures: number } }>;
}

export class AdminApi {
  constructor(private readonly baseUrl = "") {}

  async verify(token: string): Promise<void> {
    await this.request("/api/v1/admin/auth/verify", token);
  }

  dashboard(token: string): Promise<Dashboard> {
    return this.request<Dashboard>("/api/v1/admin/dashboard", token);
  }

  async applications(token: string): Promise<Application[]> {
    const result = await this.request<{ items: Application[] }>("/api/v1/admin/applications", token);
    return result.items;
  }

  createApplication(token: string, body: unknown) {
    return this.request<{ application: Application; apiKey: string; apiSecret: string }>("/api/v1/admin/applications", token, { method: "POST", body });
  }

  createApplicationCredential(token: string, id: string) {
    return this.request<{ apiKey: string; apiSecret: string }>(`/api/v1/admin/applications/${encodeURIComponent(id)}/credentials`, token, { method: "POST" });
  }

  revokeApplicationCredential(token: string, id: string, credentialId: string) {
    return this.request<void>(`/api/v1/admin/applications/${encodeURIComponent(id)}/credentials/${encodeURIComponent(credentialId)}/revoke`, token, { method: "POST" });
  }

  rotateApplication(token: string, id: string) {
    return this.request<{ apiKey: string; apiSecret: string }>(`/api/v1/admin/applications/${encodeURIComponent(id)}/rotate-credentials`, token, { method: "POST" });
  }

  updateApplication(token: string, id: string, body: unknown) {
    return this.request<Application>(`/api/v1/admin/applications/${encodeURIComponent(id)}`, token, { method: "PATCH", body });
  }

  async providers(token: string): Promise<Provider[]> {
    const result = await this.request<{ items: Provider[]; supportedTypes: string[] }>("/api/v1/admin/providers", token);
    return result.items;
  }

  createProvider(token: string, body: unknown) {
    return this.request<Provider>("/api/v1/admin/providers", token, { method: "POST", body });
  }

  updateProvider(token: string, id: string, body: unknown) {
    return this.request<Provider>(`/api/v1/admin/providers/${encodeURIComponent(id)}`, token, { method: "PATCH", body });
  }

  disableProvider(token: string, id: string) {
    return this.request<Provider>(`/api/v1/admin/providers/${encodeURIComponent(id)}/force-disable`, token, { method: "POST" });
  }

  testProvider(token: string, id: string, body: { phone: string; message: string }) {
    return this.request<unknown>(`/api/v1/admin/providers/${encodeURIComponent(id)}/test`, token, { method: "POST", body });
  }

  usage(token: string, params: Record<string, string> = {}) {
    const search = new URLSearchParams(params).toString();
    return this.request<{ items: UsageEvent[]; total: number }>(`/api/v1/admin/usage${search ? `?${search}` : ""}`, token);
  }

  summary(token: string, params: Record<string, string> = {}) {
    const search = new URLSearchParams(params).toString();
    return this.request<UsageSummary>(`/api/v1/admin/reports/summary${search ? `?${search}` : ""}`, token);
  }

  async auditLogs(token: string): Promise<AuditLog[]> {
    const result = await this.request<{ items: AuditLog[] }>("/api/v1/admin/audit-logs?limit=100", token);
    return result.items;
  }

  async rateLimits(token: string): Promise<RateLimitConfig[]> {
    const result = await this.request<{ items: RateLimitConfig[] }>("/api/v1/admin/rate-limits", token);
    return result.items;
  }

  updateRateLimit(token: string, id: string, body: unknown) {
    return this.request<RateLimitConfig>(`/api/v1/admin/rate-limits/${encodeURIComponent(id)}`, token, { method: "PATCH", body });
  }

  systemHealth(token: string) {
    return this.request<SystemHealth>("/api/v1/admin/system/health", token);
  }

  private async request<T = unknown>(path: string, token: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const data = await response.json().catch(() => null) as T | ApiErrorBody | null;
    if (!response.ok) {
      const error = data as ApiErrorBody | null;
      throw new Error(`${error?.error?.code ?? "REQUEST_FAILED"}: ${error?.error?.message ?? `HTTP ${response.status}`}`);
    }
    return data as T;
  }
}
