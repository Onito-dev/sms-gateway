import { randomUUID } from "node:crypto";
import { AppError, ERROR_CODES } from "../../common/errors.js";
import { generateOtpCode, hashOtpCode, safeEqualHex } from "../../common/crypto.js";
import { normalizePhone } from "../../common/phone.js";
import type { KeyValueStore } from "../../infrastructure/redis/store.js";
import type { Logger } from "../../infrastructure/logging/logger.js";
import type { GatewaySendOutcome } from "../providers/provider.manager.js";
import type { RateLimitService, RateLimitConfigRow } from "../rate-limit/rate-limit.service.js";
import type { QuotaService, QuotaLimit } from "../rate-limit/quota.service.js";
import { IdempotencyService } from "./idempotency.service.js";
import type {
  AppContext,
  OtpConfig,
  OtpMetricsHooks,
  OtpRepository,
  RequestOtpInput,
  RequestOtpResult,
  SmsGatewayPort,
  VerifyOtpInput,
} from "./otp.types.js";
import { noopMetrics } from "./otp.types.js";

interface StoredOtp {
  codeHash: string;
  phone: string;
  purpose: string;
  attempts: number;
}

function otpKey(applicationId: string, requestId: string): string {
  return `otp:${applicationId}:${requestId}`;
}

export class OtpService {
  private defaultCountry = "IR";

  constructor(
    private readonly store: KeyValueStore,
    private readonly config: OtpConfig,
    private readonly masterKey: string,
    private readonly repo: OtpRepository,
    private readonly gateway: SmsGatewayPort,
    private readonly rateLimiter: RateLimitService,
    private readonly quotas: QuotaService,
    private readonly log: Logger,
    private readonly deps: {
      getRateLimitConfigs: () => Promise<RateLimitConfigRow[]>;
      getQuotas: (applicationId: string) => Promise<QuotaLimit[]>;
      recordUsage?: (input: import("./otp.types.js").UsageRecordInput) => Promise<void>;
      idempotency?: IdempotencyService;
      metrics?: OtpMetricsHooks;
    },
  ) {}

  setDefaultCountry(iso: string): void {
    this.defaultCountry = iso.toUpperCase();
  }

  private metrics(): OtpMetricsHooks {
    return this.deps.metrics ?? noopMetrics;
  }

  /** Metrics are observability side effects and must never change OTP behavior. */
  private safeMetric(action: string, callback: () => void): void {
    try {
      callback();
    } catch (err) {
      this.log.warn({ err, action }, "OTP metric update failed");
    }
  }

  private policy(app: AppContext): OtpConfig {
    const p = app.otpPolicy;
    return {
      length: p?.length ?? this.config.length,
      ttlSeconds: p?.ttlSeconds ?? this.config.ttlSeconds,
      maxAttempts: p?.maxAttempts ?? this.config.maxAttempts,
      resendCooldownSeconds: p?.resendCooldownSeconds ?? this.config.resendCooldownSeconds,
      messageTemplate: this.config.messageTemplate,
    };
  }

  async requestOtp(
    app: AppContext,
    input: RequestOtpInput,
    meta: { ip: string; idempotencyKey?: string },
  ): Promise<RequestOtpResult> {
    const idem = this.deps.idempotency;
    const idempotencyKey = meta.idempotencyKey;
    if (app.status !== "ACTIVE") throw new AppError(
      ERROR_CODES.APPLICATION_DISABLED,
      "Application is disabled",
      403,
    );
    const normalizedInput = normalizePhone(input.phone, this.defaultCountry);
    const phoneFingerprint = IdempotencyService.fingerprint({ phone: normalizedInput.e164, purpose: input.purpose });
    let claimOwned = false;
    let cooldownClaimed = false;

    if (idem && idempotencyKey) {
      const replay = await idem.claim(app.id, idempotencyKey, phoneFingerprint);
      if (replay) {
        this.safeMetric("otp_request_replayed", () => this.metrics().otpRequestReplayed());
        this.log.info({ applicationId: app.id }, "OTP request replayed via idempotency key");
        return { ...(replay.body as RequestOtpResult), replayed: true };
      }
      claimOwned = true;
    }

    let quotaReservation: import("../rate-limit/quota.service.js").QuotaReservation | null = null;

    try {
      const policy = this.policy(app);
      if (!Number.isInteger(policy.length) || policy.length < 4 || policy.length > 12 ||
          !Number.isInteger(policy.ttlSeconds) || policy.ttlSeconds <= 0 ||
          !Number.isInteger(policy.maxAttempts) || policy.maxAttempts <= 0 ||
          !Number.isInteger(policy.resendCooldownSeconds) || policy.resendCooldownSeconds < 0) {
        throw AppError.validation("Invalid OTP policy configuration");
      }
      const phone = normalizedInput;

      if (!app.allowedCountries.includes("*") && !app.allowedCountries.includes(phone.countryIso)) {
        throw AppError.countryNotAllowed(phone.countryIso);
      }

      const dbConfigs = await this.deps.getRateLimitConfigs();
      const effective = this.rateLimiter.effectiveLimits(dbConfigs, app.rateLimits);
      const cooldown = app.otpPolicy?.resendCooldownSeconds ?? effective.resendCooldownSeconds;

      try {
        cooldownClaimed = await this.rateLimiter.claimResendCooldown(app.id, phone.e164, cooldown);
        await this.rateLimiter.assertOtpRequestAllowed(
          { applicationId: app.id, ip: meta.ip, phoneE164: phone.e164 },
          effective,
        );
      } catch (err) {
        if (err instanceof AppError && err.code === ERROR_CODES.OTP_RATE_LIMITED) {
          this.safeMetric("rate_limited", () => this.metrics().rateLimited("otp"));
          await this.recordUsage({
            applicationId: app.id,
            phoneCountry: phone.countryIso,
            smsCount: 0,
            status: "RATE_LIMITED",
            error: err.message,
          });
        }
        throw err;
      }

      const quotas = await this.deps.getQuotas(app.id);
      try {
        const estimate = await this.gateway.estimateCost({ phone: phone.e164, message: "", purpose: input.purpose, countryIso: phone.countryIso, strategy: app.providerStrategy });
        quotaReservation = await this.quotas.reserveSmsQuota(app.id, quotas, estimate);
      } catch (err) {
        if (err instanceof AppError && err.code === ERROR_CODES.QUOTA_EXCEEDED) {
          this.safeMetric("quota_exceeded", () => this.metrics().quotaExceeded());
          await this.recordUsage({
            applicationId: app.id,
            phoneCountry: phone.countryIso,
            smsCount: 0,
            status: "QUOTA_EXCEEDED",
            error: err.message,
          });
        }
        throw err;
      }

      const requestId = randomUUID();
      const code = generateOtpCode(policy.length);
      const stored: StoredOtp = {
        codeHash: hashOtpCode(code, this.masterKey),
        phone: phone.e164,
        purpose: input.purpose,
        attempts: 0,
      };
      const expiresAt = new Date(Date.now() + policy.ttlSeconds * 1000);

      // Persist metadata using the same UUID that becomes the Redis key.
      const row = await this.repo.create({
        id: requestId,
        applicationId: app.id,
        phone: phone.e164,
        purpose: input.purpose,
        expiresAt,
        ip: meta.ip,
      });
      try {
        await this.store.setJson(otpKey(app.id, row.id), stored, policy.ttlSeconds);
      } catch (error) {
        if (quotaReservation) {
          await this.quotas.releaseReservation(quotaReservation).catch(() => undefined);
          quotaReservation = null;
        }
        await this.repo.markFailed(row.id, "OTP_STORAGE_UNAVAILABLE").catch(() => undefined);
        throw new AppError(ERROR_CODES.INTERNAL_ERROR, "OTP state is temporarily unavailable", 503, error);
      }

      const message = policy.messageTemplate.replace("{{code}}", code);
      let outcome: GatewaySendOutcome;
      try {
        outcome = await this.gateway.send({
          phone: phone.e164,
          message,
          purpose: input.purpose,
          countryIso: phone.countryIso,
          strategy: app.providerStrategy,
        });
      } catch (err) {
        const appError = err instanceof AppError ? err : new AppError(
          ERROR_CODES.PROVIDER_ERROR,
          "Failed to send OTP via SMS provider",
          502,
        );
        await this.repo.markFailed(row.id, appError.code).catch(() => undefined);
        // A failed delivery must never leave a verifiable OTP in Redis.
        await this.store.del(otpKey(app.id, row.id)).catch(() => undefined);
        await this.recordUsage({
          applicationId: app.id,
          otpRequestId: row.id,
          phoneCountry: phone.countryIso,
          status: appError.code === ERROR_CODES.NO_PROVIDER_AVAILABLE ? "REJECTED" : "FAILED",
          error: appError.code,
        });
        throw appError;
      }

      const result: RequestOtpResult = {
        request_id: row.id,
        expires_in: policy.ttlSeconds,
        resend_after: cooldown,
      };

      if (outcome.ok) {
        // Delivery succeeded; bookkeeping is deliberately best-effort so a
        // transient metrics/DB/Redis failure cannot make the client resend SMS.
        await this.repo.markSent(row.id, outcome.providerId ?? "").catch((err) =>
          this.log.warn({ err, requestId: row.id }, "Failed to mark OTP as sent"),
        );
        if (quotaReservation) {
          await this.quotas.settleReservation(quotaReservation, outcome.costUsd).catch((err) =>
            this.log.warn({ err, applicationId: app.id }, "Failed to settle quota reservation"),
          );
        } else {
          await this.quotas.recordUsage(app.id, outcome.costUsd).catch((err) =>
            this.log.warn({ err, applicationId: app.id }, "Failed to record quota usage"),
          );
        }
        await this.rateLimiter.setResendCooldown(app.id, phone.e164, cooldown).catch((err) =>
          this.log.warn({ err, applicationId: app.id }, "Failed to set resend cooldown"),
        );
        this.safeMetric("sms_sent", () => this.metrics().smsSent(outcome.providerId ?? undefined));
        this.safeMetric("usage_cost", () => this.metrics().addCost(outcome.costUsd));
        await this.recordUsage({
          applicationId: app.id,
          providerId: outcome.providerId,
          otpRequestId: row.id,
          phoneCountry: phone.countryIso,
          status: "SUCCESS",
          providerCost: outcome.costUsd,
          latencyMs: outcome.latencyMs,
        });
        this.log.info(
          {
            applicationId: app.id,
            requestId: row.id,
            providerId: outcome.providerId,
            status: "SENT",
            duration: outcome.latencyMs,
            cost: outcome.costUsd,
          },
          "OTP sent",
        );
        if (idem && idempotencyKey) {
          // SMS delivery already succeeded. Never release the in-flight
          // marker on a cache-write failure: doing so would allow a retry to
          // send a duplicate SMS. The marker will expire if Redis is down.
          claimOwned = false;
          await idem.complete(app.id, idempotencyKey, { statusCode: 200, body: result, fingerprint: phoneFingerprint }).catch((err) =>
            this.log.warn({ err, applicationId: app.id }, "Failed to cache idempotent OTP response"),
          );
        }
        cooldownClaimed = false;
        quotaReservation = null;
        this.safeMetric("otp_request_new", () => this.metrics().otpRequestNew());
        return result;
      }

      await this.repo.markFailed(row.id, outcome.error ?? "unknown").catch((err) =>
        this.log.warn({ err, requestId: row.id }, "Failed to mark OTP delivery as failed"),
      );
      // A failed delivery must never leave a verifiable OTP in Redis, even if
      // the metadata update above fails.
      await this.store.del(otpKey(app.id, row.id)).catch((err) =>
        this.log.warn({ err, requestId: row.id }, "Failed to remove failed OTP from Redis"),
      );
      if (quotaReservation) {
        await this.quotas.releaseReservation(quotaReservation).catch((err) =>
          this.log.warn({ err, applicationId: app.id }, "Failed to release quota reservation"),
        );
        quotaReservation = null;
      }
      await this.recordUsage({
        applicationId: app.id,
        providerId: outcome.providerId,
        otpRequestId: row.id,
        phoneCountry: phone.countryIso,
        status: "FAILED",
        latencyMs: outcome.latencyMs,
        error: outcome.error,
      });
      this.safeMetric("sms_failed", () => this.metrics().smsFailed(outcome.providerId ?? undefined));
      this.log.warn(
        {
          applicationId: app.id,
          requestId: row.id,
          providerId: outcome.providerId,
          status: "FAILED",
          duration: outcome.latencyMs,
          error: outcome.error,
        },
        "OTP send failed",
      );
      if (outcome.providerId === null && outcome.attempts === 0) throw AppError.noProviderAvailable();
      throw new AppError(
        outcome.error?.toLowerCase().includes("timeout")
          ? ERROR_CODES.PROVIDER_TIMEOUT
          : ERROR_CODES.PROVIDER_ERROR,
        "Failed to send OTP via SMS provider",
        502,
      );
    } catch (err) {
      if (quotaReservation) {
        await this.quotas.releaseReservation(quotaReservation).catch((releaseError) =>
          this.log.warn({ err: releaseError, applicationId: app.id }, "Failed to release quota reservation after failed delivery"),
        );
      }
      if (claimOwned && idem && idempotencyKey) {
        await idem.release(app.id, idempotencyKey).catch(() => undefined);
      }
      if (cooldownClaimed) {
        await this.rateLimiter.releaseResendCooldown(app.id, normalizedInput.e164).catch((releaseError) =>
          this.log.warn({ err: releaseError, applicationId: app.id }, "Failed to release resend cooldown after failed delivery"),
        );
      }
      throw err;
    }
  }

  private async recordUsage(input: import("./otp.types.js").UsageRecordInput): Promise<void> {
    if (!this.deps.recordUsage) return;
    await this.deps.recordUsage(input).catch((err) => {
      this.log.warn({ err, applicationId: input.applicationId }, "Failed to record usage event");
    });
  }

  async verifyOtp(app: AppContext, input: VerifyOtpInput): Promise<{ verified: true }> {
    const lockKey = `otp:lock:${app.id}:${input.requestId}`;
    const lockToken = await this.store.acquireLock(lockKey, 10);
    if (!lockToken) {
      this.safeMetric("otp_verified_failure", () => this.metrics().otpVerified(false));
      throw AppError.otpInvalid();
    }

    try {
      return await this.verifyOtpLocked(app, input);
    } finally {
      await this.store.releaseLock(lockKey, lockToken).catch(() => undefined);
    }
  }

  private async verifyOtpLocked(app: AppContext, input: VerifyOtpInput): Promise<{ verified: true }> {
    if (app.status !== "ACTIVE") {
      throw new AppError(ERROR_CODES.APPLICATION_DISABLED, "Application is disabled", 403);
    }
    const policy = this.policy(app);
    const key = otpKey(app.id, input.requestId);
    const stored = await this.store.getJson<StoredOtp>(key);
    if (!stored) {
      await this.markExpiredIfOwned(app.id, input.requestId);
      this.safeMetric("otp_verified_failure", () => this.metrics().otpVerified(false));
      throw AppError.otpExpired();
    }

    let phone: string;
    try {
      phone = normalizePhone(input.phone, this.defaultCountry).e164;
    } catch {
      this.safeMetric("otp_verified_failure", () => this.metrics().otpVerified(false));
      throw AppError.otpInvalid();
    }
    if (phone !== stored.phone) {
      this.safeMetric("otp_verified_failure", () => this.metrics().otpVerified(false));
      throw AppError.otpInvalid();
    }

    if (stored.attempts >= policy.maxAttempts) {
      await this.consume(key, input.requestId, app.id, "EXPIRED");
      this.safeMetric("otp_verified_failure", () => this.metrics().otpVerified(false));
      throw AppError.otpMaxAttempts();
    }

    if (!new RegExp(`^\\d{${policy.length}}$`).test(input.code)) {
      this.safeMetric("otp_verified_failure", () => this.metrics().otpVerified(false));
      throw AppError.otpInvalid();
    }
    const presentedHash = hashOtpCode(input.code, this.masterKey);
    if (!safeEqualHex(presentedHash, stored.codeHash)) {
      const attempts = stored.attempts + 1;
      const exhausted = attempts >= policy.maxAttempts;
      if (exhausted) {
        await this.consume(key, input.requestId, app.id, "EXPIRED");
      } else {
        const ttl = await this.store.ttl(key);
        // Redis returns 0 when less than one second remains. Never fall back
        // to the full TTL here, otherwise a failed verification could extend
        // the lifetime of an almost-expired OTP.
        if (ttl <= 0) {
          await this.consume(key, input.requestId, app.id, "EXPIRED");
          this.safeMetric("otp_verified_failure", () => this.metrics().otpVerified(false));
          throw AppError.otpExpired();
        }
        await this.store.setJson(key, { ...stored, attempts }, ttl);
        await this.repo.setAttempts(input.requestId, attempts);
      }
      this.safeMetric("otp_verified_failure", () => this.metrics().otpVerified(false));
      if (exhausted) throw AppError.otpMaxAttempts();
      throw AppError.otpInvalid();
    }

    await this.consume(key, input.requestId, app.id, "VERIFIED");
    this.safeMetric("otp_verified_success", () => this.metrics().otpVerified(true));
    this.log.info({ applicationId: app.id, requestId: input.requestId, status: "VERIFIED" }, "OTP verified");
    return { verified: true };
  }

  async getStatus(app: AppContext, requestId: string) {
    const row = await this.repo.findById(requestId);
    if (!row || row.applicationId !== app.id) throw AppError.notFound("OTP request not found");
    return {
      request_id: row.id,
      status: row.status,
      created_at: row.createdAt.toISOString(),
      verified_at: row.verifiedAt?.toISOString() ?? null,
    };
  }

  private async consume(
    key: string,
    requestId: string,
    applicationId: string,
    status: "VERIFIED" | "EXPIRED",
  ): Promise<void> {
    await this.deleteOtpKey(key);
    try {
      const row = await this.repo.findById(requestId);
      if (!row || row.applicationId !== applicationId) return;
      if (status === "VERIFIED") await this.repo.markVerified(requestId);
      else await this.repo.markExpired(requestId);
    } catch {
      // Redis consumption is authoritative for security; metadata update is best effort.
    }
  }

  private async markExpiredIfOwned(applicationId: string, requestId: string): Promise<void> {
    try {
      const row = await this.repo.findById(requestId);
      if (row?.applicationId === applicationId && (row.status === "PENDING" || row.status === "SENT")) {
        await this.repo.markExpired(requestId);
      }
    } catch {
      // Expiry metadata is best effort; Redis remains authoritative.
    }
  }

  /**
   * Do not acknowledge verification until the single-use key is removed.
   * A short retry handles transient Redis failures; persistent failures fail
   * closed instead of returning `verified: true` while the code remains live.
   */
  private async deleteOtpKey(key: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.store.del(key);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    this.log.error({ err: lastError }, "Unable to consume OTP state");
    throw new AppError(ERROR_CODES.INTERNAL_ERROR, "OTP state is temporarily unavailable", 503);

  }
}
