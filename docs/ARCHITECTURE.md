# Central OTP & SMS Gateway — Architecture

## 1. Overview

A single deployable **Modular Monolith** that centralizes OTP generation/verification and SMS delivery for many client applications ("tenants"). Each tenant authenticates with its own API credentials and owns isolated rate limits, quotas, usage and cost data.

```
Project A ─┐
Project B ─┤
Project C ─┼──→  Central OTP & SMS Gateway  ──→  SMS Provider A
Project D ─┘         (Fastify + TS)          ──→  SMS Provider B
                        │                     ──→  SMS Provider C
                 PostgreSQL + Redis
                        │
                  Admin Panel (React)
```

### Responsibilities (in scope)

OTP generation / storage / sending / verification · SMS provider management & selection · failover · provider health · rate limiting · quotas · usage metering · cost tracking · admin panel · audit logs.

### Explicitly out of scope

User accounts, passwords, sessions, JWT, refresh tokens, OAuth, SSO, roles, profiles. Consumer projects own their identity stack; they only call `POST /otp/request` and `POST /otp/verify`.

## 2. Module layout

```text
apps/api/src/
  modules/
    otp/            OTP request/verify service + routes (the core)
    applications/   Tenant CRUD, credentials, rotation, quotas
    providers/      SmsProvider interface, adapters, ProviderManager,
                    selection strategies, health + circuit breaker
    usage/          Usage events, cost snapshot, reports
    rate-limit/     Redis rate limiter + quota service (ports + Redis impl)
    admin/          Admin API (bearer token), audit log service
    health/         /health, /health/ready, /health/live
    metrics/        Prometheus counters/histograms
  infrastructure/
    database/       Prisma client
    redis/          ioredis client + RedisStore port
    encryption/     AES-256-GCM envelope encryption (master key from env)
    logging/        pino structured logging with redaction
  common/           errors, phone normalization, crypto (OTP gen/hash), types
```

Layering rule: **routes → services → ports (repos/stores/providers)**. Route handlers only parse/validate input and format output. Business logic lives in services. Services depend on narrow interfaces (`KeyValueStore`, `OtpRepository`, `SmsGateway`, `RateLimiter`) so Redis/Postgres can be swapped or faked in tests. Adding an SMS provider = adding one adapter file + a config row; the OTP core never changes.

## 3. OTP data flow

### Request

```
POST /api/v1/otp/request   (X-API-Key / X-API-Secret, optional Idempotency-Key)
 1. authenticate application (credential lookup + timing-safe secret compare)
 2. validate body (zod), normalize phone → E.164
 3. check allowed_countries
 4. rate limits (Redis): per-IP, per-application, per-phone, resend cooldown
 5. quotas (Redis counters): daily/monthly SMS + daily/monthly cost limit
 6. idempotency: replay stored response if the same key was already processed
 7. generate OTP (crypto CSPRNG) → store HMAC-SHA256 hash in Redis with TTL
    (plaintext code never stored, never returned, never logged)
 8. persist OtpRequest row (metadata only — no code in Postgres)
 9. ProviderManager selects provider (strategy + health) and sends with failover
10. record UsageEvent with cost snapshot; update provider health
11. return { request_id, expires_in, resend_after } — never the code
```

### Verify

```
POST /api/v1/otp/verify
 1. authenticate application
 2. load OTP hash from Redis (missing → OTP_EXPIRED)
 3. enforce max attempts; wrong code increments attempts (constant-time compare)
 4. on success: delete key (single-use), mark VERIFIED, return { verified: true }
```

## 4. Provider selection & failover

`ProviderManager.send()`:

1. Load active providers (cached 5s), filter: active, supports phone country, circuit not open.
2. Order by the application's strategy (`PRIORITY` | `CHEAPEST` | `WEIGHTED` | `AUTO`, default `AUTO` — AUTO = healthy providers sorted by priority, then cost).
3. Try the first provider with timeout; on **retryable** failure only (timeout / connection error — a provider that definitively rejected the send is never retried elsewhere unless the error is a transport-class failure), continue to the next candidate, up to `MAX_PROVIDER_FAILOVER`.
4. Circuit breaker: `N` consecutive failures opens the provider for `M` seconds (state in Redis, mirrored to DB health fields: last success/failure, counts, success rate, avg latency).

## 5. Storage responsibilities

| Concern            | PostgreSQL                          | Redis                                  |
|--------------------|-------------------------------------|----------------------------------------|
| OTP secret         | — (never stored)                    | HMAC hash, TTL = OTP_TTL               |
| OTP attempts       | attempt counters (audit)            | authoritative counter inside OTP key   |
| Rate limits        | config rows                         | counters (fixed window)                |
| Quotas             | config rows                         | daily/monthly counters                 |
| Idempotency        | —                                   | response cache, short TTL              |
| Circuit breaker    | health snapshot                     | live consecutive-failure counter       |
| Usage / costs      | usage_events (cost snapshot)        | —                                      |
| Provider prices    | provider_prices (history)           | —                                      |

Key naming: `otp:{appId}:{requestId}`, `otp:cd:{appId}:{phone}`, `rl:{scope}:{id}:{bucket}`, `quota:sms:{appId}:{period}`, `quota:cost:{appId}:{period}`, `cb:{providerId}`, `idem:{appId}:{key}`.

## 6. Security model

- Application auth: `X-API-Key` + `X-API-Secret`; secret stored as SHA-256 hash, compared with `timingSafeEqual`.
- Provider credentials: AES-256-GCM encrypted with `MASTER_KEY` from environment; decrypted only in-process, never logged.
- OTP: CSPRNG digits, HMAC-SHA256 hash, TTL, single-use, attempt cap, resend cooldown.
- Structured logging with redaction of secrets/authorization headers; OTP codes are never logged.
- Audit log for admin actions (actor, action, resource, ip, metadata — no OTP material).

## 7. Future channels

The sending path is channel-agnostic: `send()` receives a message and returns a result. Adding Email/WhatsApp/Voice/Telegram later means adding a `Channel` abstraction alongside `SmsProvider` without touching OTP core. Today only SMS is implemented, per scope.
