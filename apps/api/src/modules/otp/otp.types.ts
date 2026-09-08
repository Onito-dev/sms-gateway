import type { ProviderStrategy } from "@prisma/client";
import type { GatewaySendOutcome, SendRequest } from "../providers/provider.manager.js";

export type { GatewaySendOutcome, SendRequest } from "../providers/provider.manager.js";
import type { RateLimitConfigRow } from "../rate-limit/rate-limit.service.js";
import type { QuotaLimit } from "../rate-limit/quota.service.js";

export interface OtpPolicyOverrides {
  length?: number;
  ttlSeconds?: number;
  maxAttempts?: number;
  resendCooldownSeconds?: number;
}

/** Application context threaded through every tenant-scoped operation. */
export interface AppContext {
  id: string;
  name: string;
  status: "ACTIVE" | "DISABLED";
  allowedCountries: string[];
  otpPolicy: OtpPolicyOverrides | null;
  rateLimits: Partial<{
    ipPerMinute: number;
    appPerMinute: number;
    phonePer10Minutes: number;
    resendCooldownSeconds: number;
  }> | null;
  providerStrategy: ProviderStrategy;
}

export interface OtpConfig {
  length: number;
  ttlSeconds: number;
  maxAttempts: number;
  resendCooldownSeconds: number;
  messageTemplate: string;
}

/** Persistence port for OTP request metadata (no codes, ever). */
export interface UsageRecordInput {
  applicationId: string;
  providerId?: string | null;
  otpRequestId?: string | null;
  phoneCountry: string;
  smsCount?: number;
  status: "SUCCESS" | "FAILED" | "REJECTED" | "RATE_LIMITED" | "QUOTA_EXCEEDED";
  providerCost?: number;
  latencyMs?: number | null;
  error?: string | null;
}

export interface OtpRepository {
  create(data: {
    id: string;
    applicationId: string;
    phone: string;
    purpose: string;
    expiresAt: Date;
    ip?: string;
  }): Promise<{ id: string }>;
  markSent(id: string, providerId: string): Promise<void>;
  markVerified(id: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  markExpired(id: string): Promise<void>;
  setAttempts(id: string, attempts: number): Promise<void>;
  findById(id: string): Promise<{
    id: string;
    applicationId: string;
    phone: string;
    status: string;
    createdAt: Date;
    verifiedAt: Date | null;
  } | null>;
}

/** Metrics hooks — implemented by the Prometheus module, no-op in tests. */
export interface OtpMetricsHooks {
  otpRequestNew(): void;
  otpRequestReplayed(): void;
  otpVerified(success: boolean): void;
  smsSent(providerId?: string): void;
  smsFailed(providerId?: string): void;
  rateLimited(scope: string): void;
  quotaExceeded(): void;
  addCost(costUsd: number): void;
}

export const noopMetrics: OtpMetricsHooks = {
  otpRequestNew: () => undefined,
  otpRequestReplayed: () => undefined,
  otpVerified: () => undefined,
  smsSent: () => undefined,
  smsFailed: () => undefined,
  rateLimited: () => undefined,
  quotaExceeded: () => undefined,
  addCost: () => undefined,
};

export type SmsGatewayPort = {
  send(request: SendRequest): Promise<GatewaySendOutcome>;
  /** Returns a conservative cost estimate before delivery for quota reservation. */
  estimateCost(request: SendRequest): Promise<number>;
};

export interface RequestOtpInput {
  phone: string;
  purpose: string;
}

export interface VerifyOtpInput {
  requestId: string;
  phone: string;
  code: string;
}

export interface RequestOtpResult {
  request_id: string;
  expires_in: number;
  resend_after: number;
  replayed?: boolean;
}
