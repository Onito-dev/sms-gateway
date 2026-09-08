import { AppError } from "../../common/errors.js";
import type { KeyValueStore } from "../../infrastructure/redis/store.js";

export interface EffectiveRateLimits {
  ipPerMinute: number;
  appPerMinute: number;
  phonePer10Minutes: number;
  resendCooldownSeconds: number;
}

export interface RateLimitConfigRow {
  key: string;
  scope: "IP" | "APPLICATION" | "PHONE";
  limit: number;
  windowSeconds: number;
  enabled: boolean;
}

/** Rate limiting decision context. */
export interface RateLimitTarget {
  applicationId: string;
  ip: string;
  phoneE164?: string;
}

export class RateLimitService {
  constructor(
    private readonly store: KeyValueStore,
    private readonly defaults: EffectiveRateLimits,
  ) {}

  /**
   * Checks all limits for an OTP request. Throws OTP_RATE_LIMITED on violation.
   * Limits are fixed-window counters: rl:{scope}:{id}:{bucket}
   */
  async assertOtpRequestAllowed(
    target: RateLimitTarget,
    limits: EffectiveRateLimits,
  ): Promise<void> {
    const minuteBucket = this.bucket(60);
    const tenMinuteBucket = this.bucket(600);

    const checks: Array<{ key: string; limit: number; window: number; scope: string }> = [];

    if (limits.ipPerMinute > 0) {
      checks.push({
        key: `rl:ip:${target.ip}:${minuteBucket}`,
        limit: limits.ipPerMinute,
        window: 60,
        scope: "ip",
      });
    }
    if (limits.appPerMinute > 0) {
      checks.push({
        key: `rl:app:${target.applicationId}:${minuteBucket}`,
        limit: limits.appPerMinute,
        window: 60,
        scope: "application",
      });
    }
    if (target.phoneE164 && limits.phonePer10Minutes > 0) {
      checks.push({
        key: `rl:phone:${target.phoneE164}:${tenMinuteBucket}`,
        limit: limits.phonePer10Minutes,
        window: 600,
        scope: "phone",
      });
    }

    // Atomic per-key increments prevent concurrent requests from bypassing a
    // limit. A request may reserve an earlier scope before a later scope fails;
    // that is intentionally conservative for abuse prevention.
    for (const check of checks) {
      const result = await this.store.incrIfBelow(check.key, check.limit, check.window);
      if (!result.allowed) {
        throw AppError.rateLimited(`Too many OTP requests (${check.scope} limit)`);
      }
    }
  }

  /** Resend cooldown: 1 OTP per phone per cooldown window, per application. */
  async claimResendCooldown(
    applicationId: string,
    phoneE164: string,
    cooldownSeconds: number,
  ): Promise<boolean> {
    if (cooldownSeconds <= 0) return false;
    const key = `otp:cd:${applicationId}:${phoneE164}`;
    const claimed = await this.store.setIfNotExists(key, "1", cooldownSeconds);
    if (!claimed) {
      const ttl = await this.store.ttl(key);
      throw AppError.rateLimited(
        `Please wait ${Math.max(ttl, 1)}s before requesting another OTP for this number`,
      );
    }
    return true;
  }

  /** Kept for callers that only need to inspect the cooldown. */
  async assertResendCooldown(
    applicationId: string,
    phoneE164: string,
    cooldownSeconds: number,
  ): Promise<void> {
    if (cooldownSeconds <= 0) return;
    const ttl = await this.store.ttl(`otp:cd:${applicationId}:${phoneE164}`);
    if (ttl > 0) {
      throw AppError.rateLimited(
        `Please wait ${ttl}s before requesting another OTP for this number`,
      );
    }
  }

  async setResendCooldown(applicationId: string, phoneE164: string, cooldownSeconds: number): Promise<void> {
    if (cooldownSeconds <= 0) return;
    await this.store.set(`otp:cd:${applicationId}:${phoneE164}`, "1", cooldownSeconds);
  }

  async releaseResendCooldown(applicationId: string, phoneE164: string): Promise<void> {
    await this.store.del(`otp:cd:${applicationId}:${phoneE164}`);
  }

  /**
   * Merge order: DB config rows (enabled) override env defaults,
   * application-level overrides override DB rows.
   */
  effectiveLimits(
    dbConfigs: RateLimitConfigRow[],
    appOverrides?: Partial<EffectiveRateLimits> | null,
  ): EffectiveRateLimits {
    const effective: EffectiveRateLimits = { ...this.defaults };

    for (const row of dbConfigs) {
      if (!row.enabled) continue;
      switch (row.key) {
        case "ip_per_minute":
          effective.ipPerMinute = row.limit;
          break;
        case "app_per_minute":
          effective.appPerMinute = row.limit;
          break;
        case "phone_per_10_minutes":
          effective.phonePer10Minutes = row.limit;
          break;
        case "resend_cooldown_seconds":
          effective.resendCooldownSeconds = row.limit;
          break;
        default:
          break;
      }
    }

    if (appOverrides) {
      if (appOverrides.ipPerMinute !== undefined) effective.ipPerMinute = appOverrides.ipPerMinute;
      if (appOverrides.appPerMinute !== undefined) effective.appPerMinute = appOverrides.appPerMinute;
      if (appOverrides.phonePer10Minutes !== undefined)
        effective.phonePer10Minutes = appOverrides.phonePer10Minutes;
      if (appOverrides.resendCooldownSeconds !== undefined)
        effective.resendCooldownSeconds = appOverrides.resendCooldownSeconds;
    }

    return effective;
  }

  private bucket(windowSeconds: number): number {
    return Math.floor(Date.now() / 1000 / windowSeconds);
  }
}
