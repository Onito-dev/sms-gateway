# Central OTP & SMS Gateway — Agent Handoff

## Project purpose

This repository contains a modular-monolith OTP/SMS gateway. It is **not** an authentication server: consumer applications own users, passwords, sessions, JWTs, permissions, and profiles.

## Current implementation

### Backend (`apps/api`)

- Fastify 5 + TypeScript in strict mode.
- Prisma/PostgreSQL persistence with the initial migration in `apps/api/prisma/migrations/0001_init/migration.sql`.
- Redis/ioredis for OTP state, rate limits, quotas, idempotency and circuit-breaker state.
- Zod validation and stable application error codes.
- Structured Pino logging with redaction.
- Prometheus metrics at `/metrics`.
- OpenAPI/Swagger UI at `/docs`.
- Health probes at `/health`, `/health/live`, and `/health/ready`.
- Graceful shutdown in `apps/api/src/server.ts`.

### Main modules

- `src/modules/otp/`: OTP generation, HMAC hashing, Redis TTL storage, attempt limits, single-use verification, resend cooldown, request/verify routes.
- `src/modules/applications/`: multi-tenant application CRUD, API key/secret authentication, credential rotation/revocation, extra-key creation (`POST /:id/credentials`), quotas.
- `src/modules/providers/`: provider interface (with per-adapter `ProviderParamField` schemas), MOCK/GENERIC_HTTP/KAVENEGAR/SMSIR adapters, provider registry + param-schema lookup, save-time credential/config validation (`provider-params.ts`), selection strategies, failover, pricing snapshots, health and circuit breaker.
- `src/modules/rate-limit/`: Redis-backed IP/application/phone rate limiting and quota counters.
- `src/modules/usage/`: immutable usage events, provider cost snapshots, reports and dashboard aggregates.
- `src/modules/admin/`: bearer-token admin authentication and audit logging/routes.
- `src/modules/settings/`: runtime-editable settings stored in PostgreSQL (`Setting` key/value table); currently `cors_origins` — the CORS allowed-origins list editable from the admin panel (Settings → Allowed websites). `app.ts` registers `@fastify/cors` with a dynamic origin resolver: DB setting first, env `CORS_ORIGINS` as seed/fallback (also used when the DB is unreachable), 5-second in-memory cache, exact origin match (scheme + host + port, trailing slash tolerated, case-insensitive), `*` reflects all origins, non-allowed origins get no CORS headers.
- `src/modules/health/` and `src/modules/metrics/`: operational endpoints.

### Admin frontend (`apps/admin`)

React + Vite + TypeScript single-page console with:

- dashboard
- application creation, status control and credential rotation
- provider listing, creation, disable and test SMS
- usage/cost report and filters
- audit log view
- system health and global rate-limit editing
- CORS allowed-origins editor (Settings → Allowed websites (CORS))

The admin token is kept in `sessionStorage`; API secrets are only shown after create/rotate.

### Reusable client (`packages/otp-client`)

`OtpClient` is a dependency-free TypeScript client exposing `request`, `verify`, and `status`. It sends `X-API-Key` and `X-API-Secret` and supports `Idempotency-Key`.

## Important invariants

1. OTP plaintext is never persisted, returned, logged, or stored in PostgreSQL. Redis stores only an HMAC hash.
2. Redis OTP key format is `otp:{applicationId}:{requestId}` and `requestId` is the same UUID persisted in `OtpRequest`.
3. Every application-facing OTP operation authenticates one active application and scopes all data by `applicationId`.
4. API secrets are stored as SHA-256 hashes. Provider credentials are AES-256-GCM encrypted using `MASTER_KEY`.
5. Provider failover is attempted only for adapter results marked retryable; unknown adapter crashes are not retried to reduce duplicate SMS risk.
6. Usage stores the provider price at send time, so historical costs do not change when provider prices change.
7. Admin responses redact provider configuration secrets and never expose credential hashes or encrypted credentials.

## Runtime setup

1. Copy `.env.example` to `.env` and replace `MASTER_KEY` and `ADMIN_TOKEN` with strong random values.
2. Start PostgreSQL and Redis, or use the root Docker Compose file once present.
3. Install workspace dependencies with the repository package manager.
4. Generate Prisma Client, deploy the migration, and seed defaults.
5. Start API on port 3000 and admin on port 5173.

Useful commands:

```bash
npm install
npm run db:generate --workspace apps/api
npm run db:migrate
npm run db:seed
npm run dev:api
npm run dev:admin
npm run typecheck
npm test
```

## Safe continuation notes

- Read existing files before editing; this workspace has already received substantial implementation.
- Do not add user-management or authentication-domain behavior.
- Do not log OTP codes, API secrets, bearer tokens, provider credentials, or authorization headers.
- Keep tenant-bound database queries explicit.
- Use the existing provider interface and registry for new SMS adapters.
- Run `npm run typecheck` and relevant tests after changes.
- A real provider integration should be tested with mocks first; never send production SMS from automated tests.

## Known scope boundaries

The current system is intentionally simple. A production deployment should still add infrastructure-level HTTPS/reverse proxy, secret management, database backup scheduling, alerting, and a real admin identity provider or network restriction instead of relying only on one static bearer token.
