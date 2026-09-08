import { describe, expect, it, vi, afterEach } from "vitest";
import { AppError, ERROR_CODES } from "../src/common/errors.js";
import { generateOtpCode, hashOtpCode, safeEqualHex, generateCredentialPair, verifyApiSecret } from "../src/common/crypto.js";
import { normalizePhone } from "../src/common/phone.js";
import { RateLimitService } from "../src/modules/rate-limit/rate-limit.service.js";
import { QuotaService } from "../src/modules/rate-limit/quota.service.js";
import { IdempotencyService } from "../src/modules/otp/idempotency.service.js";
import { OtpService } from "../src/modules/otp/otp.service.js";
import { MockProvider } from "../src/modules/providers/adapters/mock.provider.js";
import { SmsIrProvider } from "../src/modules/providers/adapters/smsir.provider.js";
import type { KeyValueStore } from "../src/infrastructure/redis/store.js";
import type { AppContext, OtpRepository } from "../src/modules/otp/otp.types.js";
import { ProviderManager, type GatewaySendOutcome } from "../src/modules/providers/provider.manager.js";

class MemoryStore implements KeyValueStore {
  private readonly values = new Map<string, { value: string; expiresAt: number | null }>();

  private getEntry(key: string) {
    const entry = this.values.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.values.delete(key);
      return null;
    }
    return entry ?? null;
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const current = Number(this.getEntry(key)?.value ?? "0") + 1;
    const entry = this.getEntry(key);
    this.values.set(key, { value: String(current), expiresAt: entry?.expiresAt ?? Date.now() + ttlSeconds * 1000 });
    return current;
  }

  async incrByFloat(key: string, value: number, ttlSeconds: number): Promise<number> {
    const current = Number(this.getEntry(key)?.value ?? "0") + value;
    const entry = this.getEntry(key);
    this.values.set(key, { value: String(current), expiresAt: entry?.expiresAt ?? Date.now() + ttlSeconds * 1000 });
    return current;
  }

  async incrByFloatIfBelow(key: string, increment: number, limit: number, ttlSeconds: number) {
    const current = Number(this.getEntry(key)?.value ?? "0");
    if (current + increment > limit) return { allowed: false, current };
    const next = current + increment;
    const entry = this.getEntry(key);
    this.values.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? Date.now() + ttlSeconds * 1000 });
    return { allowed: true, current: next };
  }

  async decrBy(key: string, value: number) {
    const next = Math.max(0, Number(this.getEntry(key)?.value ?? "0") - value);
    if (next === 0) this.values.delete(key); else this.values.set(key, { value: String(next), expiresAt: this.getEntry(key)?.expiresAt ?? null });
    return next;
  }

  async decrByFloat(key: string, value: number) {
    return this.decrBy(key, value);
  }

  async incrIfBelow(key: string, limit: number, ttlSeconds: number) {
    const current = Number(this.getEntry(key)?.value ?? "0");
    if (current >= limit) return { allowed: false, current };
    const next = current + 1;
    const entry = this.getEntry(key);
    this.values.set(key, { value: String(next), expiresAt: entry?.expiresAt ?? Date.now() + ttlSeconds * 1000 });
    return { allowed: true, current: next };
  }

  async get(key: string) { return this.getEntry(key)?.value ?? null; }

  async set(key: string, value: string, ttlSeconds: number) {
    this.values.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async del(key: string) { this.values.delete(key); }

  async setIfNotExists(key: string, value: string, ttlSeconds: number) {
    if (this.getEntry(key)) return false;
    await this.set(key, value, ttlSeconds);
    return true;
  }

  async getJson<T>(key: string) {
    const value = await this.get(key);
    return value === null ? null : JSON.parse(value) as T;
  }

  async setJson(key: string, value: unknown, ttlSeconds: number) {
    await this.set(key, JSON.stringify(value), ttlSeconds);
  }

  async ttl(key: string) {
    const entry = this.getEntry(key);
    if (!entry) return -2;
    if (entry.expiresAt === null) return -1;
    return Math.max(1, Math.ceil((entry.expiresAt - Date.now()) / 1000));
  }

  async acquireLock(key: string, ttlSeconds: number) {
    const token = `lock-${Math.random()}`;
    return await this.setIfNotExists(key, token, ttlSeconds) ? token : null;
  }

  async releaseLock(key: string, token: string) {
    if (await this.get(key) === token) await this.del(key);
  }
}

class FakeOtpRepository implements OtpRepository {
  readonly rows = new Map<string, { id: string; applicationId: string; phone: string; status: string; createdAt: Date; verifiedAt: Date | null; attempts: number }>();

  async create(data: { id: string; applicationId: string; phone: string; purpose: string; expiresAt: Date; ip?: string }) {
    this.rows.set(data.id, { id: data.id, applicationId: data.applicationId, phone: data.phone, status: "PENDING", createdAt: new Date(), verifiedAt: null, attempts: 0 });
    return { id: data.id };
  }
  async markSent(id: string) { const row = this.rows.get(id)!; row.status = "SENT"; }
  async markVerified(id: string) { const row = this.rows.get(id)!; row.status = "VERIFIED"; row.verifiedAt = new Date(); }
  async markFailed(id: string) { const row = this.rows.get(id)!; row.status = "FAILED"; }
  async markExpired(id: string) { const row = this.rows.get(id)!; row.status = "EXPIRED"; }
  async setAttempts(id: string, attempts: number) { this.rows.get(id)!.attempts = attempts; }
  async findById(id: string) {
    const row = this.rows.get(id);
    return row ? { id: row.id, applicationId: row.applicationId, phone: row.phone, status: row.status, createdAt: row.createdAt, verifiedAt: row.verifiedAt } : null;
  }
}

const logger = {
  fatal() {}, error() {}, warn() {}, info() {}, debug() {}, trace() {},
} as never;

const app: AppContext = {
  id: "app-1",
  name: "Test app",
  status: "ACTIVE",
  allowedCountries: ["*"],
  otpPolicy: { length: 6, ttlSeconds: 120, maxAttempts: 3, resendCooldownSeconds: 0 },
  rateLimits: null,
  providerStrategy: "AUTO",
};

function successfulGateway(): { gateway: { send: (input: unknown) => Promise<GatewaySendOutcome>; estimateCost: (input: unknown) => Promise<number> }; sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    gateway: { estimateCost: async () => 0, send: async (input) => { sent.push(JSON.stringify(input)); return { ok: true, providerId: "provider-1", providerName: "test", providerType: "MOCK", costUsd: 0, latencyMs: 1, attempts: 1 }; } },
  };
}

describe("cryptography", () => {
  it("generates fixed-length numeric OTPs with secure hashing", () => {
    const code = generateOtpCode(6);
    expect(code).toMatch(/^\d{6}$/);
    const hash = hashOtpCode(code, "a-master-key-that-is-long-enough");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(safeEqualHex(hash, hash)).toBe(true);
    expect(safeEqualHex(hash, hashOtpCode("000000", "a-master-key-that-is-long-enough"))).toBe(false);
  });

  it("stores only a verifiable hash for application credentials", () => {
    const pair = generateCredentialPair();
    expect(pair.secretHash).not.toContain(pair.apiSecret);
    expect(verifyApiSecret(pair.apiSecret, pair.secretHash)).toBe(true);
    expect(verifyApiSecret("wrong", pair.secretHash)).toBe(false);
  });
});

describe("phone normalization", () => {
  it.each(["09121234567", "+989121234567", "00989121234567", "989121234567"])("normalizes %s to E.164", (input) => {
    expect(normalizePhone(input, "IR")).toEqual({ e164: "+989121234567", countryIso: "IR" });
  });

  it("rejects malformed numbers", () => {
    expect(() => normalizePhone("not-a-phone", "IR")).toThrowError(AppError);
    try { normalizePhone("not-a-phone", "IR"); } catch (error) { expect((error as AppError).code).toBe(ERROR_CODES.INVALID_PHONE); }
  });
});

describe("rate limiting and idempotency", () => {
  it("blocks the request after the configured limit", async () => {
    const store = new MemoryStore();
    const limiter = new RateLimitService(store, { ipPerMinute: 2, appPerMinute: 100, phonePer10Minutes: 100, resendCooldownSeconds: 0 });
    const target = { applicationId: "app", ip: "127.0.0.1", phoneE164: "+989121234567" };
    await limiter.assertOtpRequestAllowed(target, limiter.effectiveLimits([], null));
    await limiter.assertOtpRequestAllowed(target, limiter.effectiveLimits([], null));
    await expect(limiter.assertOtpRequestAllowed(target, limiter.effectiveLimits([], null))).rejects.toMatchObject({ code: ERROR_CODES.OTP_RATE_LIMITED });
  });

  it("isolates idempotency by application and replays completed responses", async () => {
    const service = new IdempotencyService(new MemoryStore(), 60);
    const firstFingerprint = IdempotencyService.fingerprint({ phone: "+989121234567", purpose: "login" });
    const otherFingerprint = IdempotencyService.fingerprint({ phone: "+989121234568", purpose: "login" });
    expect(await service.claim("app-a", "same-key", firstFingerprint)).toBeNull();
    await service.complete("app-a", "same-key", { statusCode: 200, body: { request_id: "r1" }, fingerprint: firstFingerprint });
    expect(await service.claim("app-a", "same-key", firstFingerprint)).toEqual({ statusCode: 200, body: { request_id: "r1" }, fingerprint: firstFingerprint });
    await expect(service.claim("app-a", "same-key", otherFingerprint)).rejects.toMatchObject({ code: ERROR_CODES.IDEMPOTENCY_KEY_REUSED });
    expect(await service.claim("app-b", "same-key", firstFingerprint)).toBeNull();
  });
});

describe("OTP security flow", () => {
  it("verifies once and rejects replay", async () => {
    const store = new MemoryStore();
    const repo = new FakeOtpRepository();
    const sent = successfulGateway();
    const service = new OtpService(store, { length: 6, ttlSeconds: 120, maxAttempts: 3, resendCooldownSeconds: 0, messageTemplate: "Code {{code}}" }, "master-key-for-tests", repo, sent.gateway, new RateLimitService(store, { ipPerMinute: 100, appPerMinute: 100, phonePer10Minutes: 100, resendCooldownSeconds: 0 }), new QuotaService(store), logger, { getRateLimitConfigs: async () => [], getQuotas: async () => [], recordUsage: async () => {} });
    const requested = await service.requestOtp(app, { phone: "09121234567", purpose: "login" }, { ip: "127.0.0.1" });
    const message = JSON.parse(sent.sent[0]! as string).message as string;
    const code = message.match(/\d{6}/)![0];
    await expect(service.verifyOtp(app, { requestId: requested.request_id, phone: "+989121234567", code })).resolves.toEqual({ verified: true });
    await expect(service.verifyOtp(app, { requestId: requested.request_id, phone: "+989121234567", code })).rejects.toMatchObject({ code: ERROR_CODES.OTP_EXPIRED });
    expect(repo.rows.get(requested.request_id)?.status).toBe("VERIFIED");
  });

  it("does not allow another application to verify the request", async () => {
    const store = new MemoryStore();
    const repo = new FakeOtpRepository();
    const sent = successfulGateway();
    const service = new OtpService(store, { length: 6, ttlSeconds: 120, maxAttempts: 3, resendCooldownSeconds: 0, messageTemplate: "Code {{code}}" }, "master-key-for-tests", repo, sent.gateway, new RateLimitService(store, { ipPerMinute: 100, appPerMinute: 100, phonePer10Minutes: 100, resendCooldownSeconds: 0 }), new QuotaService(store), logger, { getRateLimitConfigs: async () => [], getQuotas: async () => [], recordUsage: async () => {} });
    const requested = await service.requestOtp(app, { phone: "+989121234567", purpose: "login" }, { ip: "127.0.0.1" });
    const message = JSON.parse(sent.sent[0]! as string).message as string;
    const code = message.match(/\d{6}/)![0];
    const otherApp: AppContext = { ...app, id: "app-2" };
    await expect(service.verifyOtp(otherApp, { requestId: requested.request_id, phone: "+989121234567", code })).rejects.toMatchObject({ code: ERROR_CODES.OTP_EXPIRED });
    await expect(service.verifyOtp(app, { requestId: requested.request_id, phone: "+989121234567", code })).resolves.toEqual({ verified: true });
  });

  it("removes the OTP when SMS delivery fails", async () => {
    const store = new MemoryStore();
    const repo = new FakeOtpRepository();
    const gateway = { estimateCost: async () => 0, send: async () => ({ ok: false as const, providerId: "provider-1", providerName: "test", providerType: "MOCK", costUsd: 0, latencyMs: 1, attempts: 1, error: "provider rejected" }) };
    const service = new OtpService(store, { length: 6, ttlSeconds: 120, maxAttempts: 3, resendCooldownSeconds: 0, messageTemplate: "Code {{code}}" }, "master-key-for-tests", repo, gateway, new RateLimitService(store, { ipPerMinute: 100, appPerMinute: 100, phonePer10Minutes: 100, resendCooldownSeconds: 0 }), new QuotaService(store), logger, { getRateLimitConfigs: async () => [], getQuotas: async () => [], recordUsage: async () => {} });
    await expect(service.requestOtp(app, { phone: "+989121234567", purpose: "login" }, { ip: "127.0.0.1" })).rejects.toMatchObject({ code: ERROR_CODES.PROVIDER_ERROR });
    const requestId = [...repo.rows.keys()][0]!;
    await expect(service.verifyOtp(app, { requestId, phone: "+989121234567", code: "000000" })).rejects.toMatchObject({ code: ERROR_CODES.OTP_EXPIRED });
    expect(repo.rows.get(requestId)?.status).toBe("FAILED");
  });

  it("invalidates the OTP after the maximum number of wrong attempts", async () => {
    const store = new MemoryStore();
    const repo = new FakeOtpRepository();
    const sent = successfulGateway();
    const service = new OtpService(store, { length: 6, ttlSeconds: 120, maxAttempts: 2, resendCooldownSeconds: 0, messageTemplate: "Code {{code}}" }, "master-key-for-tests", repo, sent.gateway, new RateLimitService(store, { ipPerMinute: 100, appPerMinute: 100, phonePer10Minutes: 100, resendCooldownSeconds: 0 }), new QuotaService(store), logger, { getRateLimitConfigs: async () => [], getQuotas: async () => [], recordUsage: async () => {} });
    const limitedApp: AppContext = { ...app, otpPolicy: { ...app.otpPolicy, maxAttempts: 2 } };
    const requested = await service.requestOtp(limitedApp, { phone: "+989121234567", purpose: "login" }, { ip: "127.0.0.1" });
    await expect(service.verifyOtp(limitedApp, { requestId: requested.request_id, phone: "+989121234567", code: "000000" })).rejects.toMatchObject({ code: ERROR_CODES.OTP_INVALID });
    await expect(service.verifyOtp(limitedApp, { requestId: requested.request_id, phone: "+989121234567", code: "000000" })).rejects.toMatchObject({ code: ERROR_CODES.OTP_MAX_ATTEMPTS });
    await expect(service.verifyOtp(limitedApp, { requestId: requested.request_id, phone: "+989121234567", code: "000000" })).rejects.toMatchObject({ code: ERROR_CODES.OTP_EXPIRED });
  });
});

describe("provider manager and adapters", () => {
  it("fails over to the next provider only for a retryable failure", async () => {
    const rows = [
      { id: "provider-a", name: "Provider A", type: "MOCK", priority: 1, weight: 1, costPerSms: 0, supportedCountries: ["*"], healthStatus: "HEALTHY", timeoutMs: 1000, credentialsEncrypted: null, config: { failNext: 1 } },
      { id: "provider-b", name: "Provider B", type: "MOCK", priority: 2, weight: 1, costPerSms: 0, supportedCountries: ["*"], healthStatus: "HEALTHY", timeoutMs: 1000, credentialsEncrypted: null, config: {} },
    ];
    const prisma = {
      smsProvider: {
        findMany: async () => rows,
        update: async () => ({}),
        findUnique: async () => ({ avgResponseMs: 0, successCount: 1 }),
      },
      providerPrice: { findFirst: async () => null },
    } as never;
    const manager = new ProviderManager(
      prisma,
      new MemoryStore(),
      {} as never,
      { maxProviderFailover: 1 },
      { failureThreshold: 5, cooldownSeconds: 60 },
      logger,
    );
    const result = await manager.send({ phone: "+989121234567", message: "Code 123456", countryIso: "IR", strategy: "PRIORITY" });
    expect(result).toMatchObject({ ok: true, providerId: "provider-b", attempts: 2 });
  });

  it("supports deterministic failure simulation without exposing message content", async () => {
    const provider = new MockProvider({ providerId: "p1", name: "mock", timeoutMs: 1000, credentials: {}, config: { failNext: 1 } });
    await expect(provider.sendSms({ phone: "+989121234567", message: "Code 123456" })).resolves.toMatchObject({ ok: false, retryable: true });
    await expect(provider.sendSms({ phone: "+989121234567", message: "Code 123456" })).resolves.toMatchObject({ ok: true });
  });
});

describe("sms.ir VERIFY adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const makeProvider = (overrides: Record<string, unknown> = {}) =>
    new SmsIrProvider({
      providerId: "smsir-1",
      name: "SMS.ir",
      timeoutMs: 5000,
      credentials: { apiKey: "test-api-key" },
      config: { templateId: 123456, ...overrides },
    });

  it("sends a verify request with template, parameter and local mobile format", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 1, data: { messageId: 89545112, cost: 1 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await makeProvider().sendSms({ phone: "+989121234567", message: "Code 482913" });

    expect(result).toMatchObject({ ok: true, providerMessageId: "89545112" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.sms.ir/v1/send/verify");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      mobile: "9121234567",
      templateId: 123456,
      parameters: [{ name: "Code", value: "482913" }],
    });
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("test-api-key");
  });

  it("can send the full country-code mobile when configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 1, data: { messageId: 1 } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await makeProvider({ mobileWithCountryCode: true }).sendSms({ phone: "+989121234567", message: "Code 482913" });
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string).mobile).toBe("989121234567");
  });

  it("rejects without an api key or template id", async () => {
    const noKey = new SmsIrProvider({ providerId: "s", name: "s", timeoutMs: 1000, credentials: {}, config: { templateId: 1 } });
    await expect(noKey.sendSms({ phone: "+989121234567", message: "Code 123456" })).resolves.toMatchObject({ ok: false, kind: "REJECTED" });
    const noTemplate = new SmsIrProvider({ providerId: "s", name: "s", timeoutMs: 1000, credentials: { apiKey: "k" }, config: {} });
    await expect(noTemplate.sendSms({ phone: "+989121234567", message: "Code 123456" })).resolves.toMatchObject({ ok: false, kind: "REJECTED" });
  });

  it("maps HTTP and API-level failures to failure kinds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 2, message: "خطا" }), { status: 401 })));
    await expect(makeProvider().sendSms({ phone: "+989121234567", message: "Code 123456" })).resolves.toMatchObject({ ok: false, kind: "AUTH", retryable: false });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 2, message: "قالب نامعتبر" }), { status: 400 })));
    await expect(makeProvider().sendSms({ phone: "+989121234567", message: "Code 123456" })).resolves.toMatchObject({ ok: false, kind: "REJECTED" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 500 })));
    await expect(makeProvider().sendSms({ phone: "+989121234567", message: "Code 123456" })).resolves.toMatchObject({ ok: false, kind: "UNKNOWN" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 1 }), { status: 200 })));
    // status===1 but no messageId — still accepted
    await expect(makeProvider().sendSms({ phone: "+989121234567", message: "Code 123456" })).resolves.toMatchObject({ ok: true });
  });

  it("treats timeout and connection errors as retryable for failover", async () => {
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortError));
    await expect(makeProvider().sendSms({ phone: "+989121234567", message: "Code 123456" })).resolves.toMatchObject({ ok: false, retryable: true, kind: "TIMEOUT" });

    const connError = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(connError));
    await expect(makeProvider().sendSms({ phone: "+989121234567", message: "Code 123456" })).resolves.toMatchObject({ ok: false, retryable: true, kind: "CONNECTION" });
  });
});
