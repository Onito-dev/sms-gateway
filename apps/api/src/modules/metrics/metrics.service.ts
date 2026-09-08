import { Counter, Gauge, Histogram, Registry } from "prom-client";
import type { OtpMetricsHooks } from "../otp/otp.types.js";

export class MetricsService implements OtpMetricsHooks {
  readonly registry = new Registry();

  private readonly otpRequests = new Counter({
    name: "otp_requests_total",
    help: "OTP requests accepted by the gateway",
    labelNames: ["result"] as const,
    registers: [this.registry],
  });
  private readonly otpVerifiedCounter = new Counter({
    name: "otp_verified_total",
    help: "OTP verification attempts",
    labelNames: ["result"] as const,
    registers: [this.registry],
  });
  private readonly smsSentCounter = new Counter({
    name: "sms_sent_total",
    help: "SMS messages sent successfully",
    labelNames: ["provider_id"] as const,
    registers: [this.registry],
  });
  private readonly smsFailedCounter = new Counter({
    name: "sms_failed_total",
    help: "SMS send attempts that failed",
    labelNames: ["provider_id"] as const,
    registers: [this.registry],
  });
  private readonly providerFailuresCounter = new Counter({
    name: "provider_failures_total",
    help: "Provider adapter failures",
    labelNames: ["provider_id"] as const,
    registers: [this.registry],
  });
  private readonly rateLimitedCounter = new Counter({
    name: "rate_limited_requests_total",
    help: "Requests rejected by rate limiting",
    labelNames: ["scope"] as const,
    registers: [this.registry],
  });
  private readonly quotaExceededCounter = new Counter({
    name: "quota_exceeded_requests_total",
    help: "Requests rejected by quota enforcement",
    registers: [this.registry],
  });
  private readonly costCounter = new Counter({
    name: "usage_cost_total_usd",
    help: "Snapshot SMS cost accumulated by successful sends",
    registers: [this.registry],
  });
  readonly providerLatency = new Histogram({
    name: "provider_latency_ms",
    help: "SMS provider response latency in milliseconds",
    labelNames: ["provider_id"] as const,
    buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000],
    registers: [this.registry],
  });
  private readonly activeApplications = new Gauge({
    name: "active_applications",
    help: "Number of active applications",
    registers: [this.registry],
  });
  private readonly activeProviders = new Gauge({
    name: "active_providers",
    help: "Number of active SMS providers",
    registers: [this.registry],
  });

  otpRequestNew(): void {
    this.otpRequests.inc({ result: "new" });
  }

  otpRequestReplayed(): void {
    this.otpRequests.inc({ result: "replayed" });
  }

  otpVerified(success: boolean): void {
    this.otpVerifiedCounter.inc({ result: success ? "success" : "failure" });
  }

  smsSent(providerId?: string): void {
    this.smsSentCounter.inc({ provider_id: providerId ?? "unknown" });
  }

  smsFailed(providerId?: string): void {
    this.smsFailedCounter.inc({ provider_id: providerId ?? "unknown" });
  }

  providerFailure(providerId: string): void {
    this.providerFailuresCounter.inc({ provider_id: providerId });
  }

  rateLimited(scope: string): void {
    this.rateLimitedCounter.inc({ scope });
  }

  quotaExceeded(): void {
    this.quotaExceededCounter.inc();
  }

  addCost(costUsd: number): void {
    if (Number.isFinite(costUsd) && costUsd > 0) this.costCounter.inc(costUsd);
  }

  setActiveCounts(applications: number, providers: number): void {
    this.activeApplications.set(applications);
    this.activeProviders.set(providers);
  }

  async metrics(): Promise<string> {
    return this.registry.metrics();
  }
}
