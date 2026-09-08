# Central OTP & SMS Gateway

A reusable, multi-application OTP and SMS gateway built as a maintainable modular monolith.

## Scope

The gateway owns OTP generation, secure temporary storage, SMS delivery, provider selection/failover, rate limiting, quotas, usage metering, cost snapshots, provider health, and administration. It deliberately does **not** own users, passwords, login sessions, JWTs, refresh tokens, OAuth, SSO, roles, or profiles.

## Architecture

- **API:** Fastify 5 + TypeScript strict mode
- **Persistence:** PostgreSQL through Prisma
- **Ephemeral state:** Redis through ioredis
- **Validation:** Zod
- **API documentation:** OpenAPI/Swagger at `/docs`
- **Admin panel:** React + Vite + TypeScript
- **Deployment:** Docker Compose, with API and admin production Dockerfiles

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the detailed request flow and storage model. See [PROJECT_HANDOFF.md](PROJECT_HANDOFF.md) for a file-by-file implementation handoff and [docs/DEVELOPER_GUIDE_FA.md](docs/DEVELOPER_GUIDE_FA.md) for a Persian developer summary.

## Repository layout

```text
apps/api/                 Fastify API and Prisma schema
apps/admin/               React administration console
packages/otp-client/      Dependency-free TypeScript consumer client
docs/                     Architecture and developer documentation
scripts/                  Operational scripts
```

## Requirements

- Node.js 20+
- npm 10+
- PostgreSQL 14+ and Redis 6+ for local non-Docker development
- Docker Compose for the complete stack

## Configuration

```bash
cp .env.example .env
```

Set a random `MASTER_KEY` with at least 32 characters and a long random `ADMIN_TOKEN`. Do not commit `.env` or real provider credentials. All environment variables are listed in `.env.example`.

## Run with Docker

```bash
cp .env.example .env
# Replace MASTER_KEY and ADMIN_TOKEN in .env
docker compose up -d --build
```

- API: `http://localhost:3000`
- Admin panel: `http://localhost:8080`
- Swagger: `http://localhost:3000/docs`
- Health: `http://localhost:3000/health`

The API container runs `prisma migrate deploy` before starting. Seed the initial mock provider and demo application with:

```bash
docker compose exec api npx prisma db seed
```

The seed prints the demo API secret once. Store it securely.

## Run locally without Docker

Start PostgreSQL and Redis, set `DATABASE_URL` and `REDIS_URL` in `.env`, then run:

```bash
npm install
npm run db:generate --workspace apps/api
npm run db:migrate
npm run db:seed
npm run dev:api
npm run dev:admin
```

The admin Vite server proxies `/api` to `localhost:3000`.

## Application API

Every consumer application uses its own active credential:

```http
X-API-Key: gw_...
X-API-Secret: ...
```

### Request an OTP

```bash
curl -X POST http://localhost:3000/api/v1/otp/request \
  -H 'content-type: application/json' \
  -H 'X-API-Key: gw_example' \
  -H 'X-API-Secret: secret_example' \
  -H 'Idempotency-Key: login-attempt-123' \
  -d '{"phone":"+989121234567","purpose":"login"}'
```

Response (the OTP is never returned):

```json
{"request_id":"...","expires_in":120,"resend_after":60}
```

### Verify an OTP

```bash
curl -X POST http://localhost:3000/api/v1/otp/verify \
  -H 'content-type: application/json' \
  -H 'X-API-Key: gw_example' \
  -H 'X-API-Secret: secret_example' \
  -d '{"request_id":"...","phone":"+989121234567","code":"123456"}'
```

A business-level invalid/expired code returns HTTP 200 with `{ "verified": false, "error": "OTP_INVALID" }`. Infrastructure and authentication failures use the standard error envelope:

```json
{"error":{"code":"...","message":"...","request_id":"..."}}
```

The consumer application decides what a successful verification means for its own user/account flow.

## Reusable TypeScript client

```ts
import { OtpClient } from "@gateway/otp-client";

const otpClient = new OtpClient({
  baseUrl: "https://gateway.example.com",
  apiKey: process.env.OTP_API_KEY!,
  apiSecret: process.env.OTP_API_SECRET!,
});

const request = await otpClient.request({
  phone: "+989121234567",
  purpose: "login",
  idempotencyKey: "your-unique-request-id",
});

const result = await otpClient.verify({
  requestId: request.request_id,
  phone: "+989121234567",
  code: codeEnteredByTheUser,
});
```

Build the package with `npm run build:client`.

## Providers

Built-in adapters:

- `MOCK`: local development and failover tests; supports `config.failNext` and `config.failRate`.
- `GENERIC_HTTP`: JSON HTTP endpoint using encrypted `apiKey` or `apiToken` credentials and configurable URL/sender.
- `KAVENEGAR`: Kavenegar Verify/Lookup adapter using an approved template.
- `SMSIR`: [sms.ir](https://sms.ir) VERIFY send (`POST https://api.sms.ir/v1/send/verify`) using an approved template. Credentials: `apiKey`. Config: `templateId` (required, from the sms.ir panel), `codeParameter` (template parameter name, default `Code`), `mobileWithCountryCode` (send `989121234567` instead of `9121234567`). Success requires HTTP 2xx **and** body `status === 1`.

To add a provider:

1. Implement `SmsProviderAdapter` in `apps/api/src/modules/providers/adapters/`.
2. Return `retryable: true` only when another attempt is safe according to the provider’s delivery semantics.
3. Register the factory in `provider.registry.ts`.
4. Create the provider through the admin API or panel.

Provider selection supports `AUTO`, `PRIORITY`, `CHEAPEST`, and `WEIGHTED`. `MAX_PROVIDER_FAILOVER` controls the number of additional candidates. Circuit state is held in Redis and health snapshots are mirrored to PostgreSQL.

## Admin panel and API

Open `http://localhost:8080` and enter `ADMIN_TOKEN`. The panel includes dashboard, applications (API key management: view, add extra keys, revoke, rotate), credential rotation, providers (including editing credentials and template config such as the SMSIR `templateId`), test SMS, usage/cost reports, audit logs, rate limits, and system health.

Admin API uses:

```http
Authorization: Bearer <ADMIN_TOKEN>
```

Important endpoints:

```text
GET    /api/v1/admin/dashboard
GET    /api/v1/admin/applications
POST   /api/v1/admin/applications
POST   /api/v1/admin/applications/:id/rotate-credentials
GET    /api/v1/admin/providers
POST   /api/v1/admin/providers
POST   /api/v1/admin/providers/:id/test
GET    /api/v1/admin/usage
GET    /api/v1/admin/reports/summary
GET    /api/v1/admin/audit-logs
```

## Security model

- OTP uses a cryptographically secure numeric generator and HMAC-SHA256 storage with TTL.
- Redis is authoritative for OTP existence, attempts, and single-use consumption.
- API secrets are stored only as SHA-256 hashes and compared in constant time.
- Provider credentials are AES-256-GCM encrypted using `MASTER_KEY`.
- Logs redact credentials, tokens, authorization headers, and OTP-related fields.
- Tenant-scoped routes obtain one active application context from credentials.
- IP, application, phone, resend cooldown, daily/monthly SMS and cost limits protect spend.
- Use HTTPS, network restrictions, a secret manager, and a stronger admin identity/network policy in production.

## Tests and quality checks

```bash
npm run typecheck
npm test
npm run build
```

Unit/security-focused tests use fakes and the mock provider; they do not send real SMS. PostgreSQL and Redis integration tests should run in CI with service containers before production releases.

## Deployment and operations

For a VPS:

1. Provision Docker, a domain, HTTPS termination/reverse proxy, PostgreSQL storage, and Redis persistence.
2. Put production values in an external `.env`/secret manager.
3. Run `docker compose up -d --build`.
4. Expose only the reverse proxy; keep PostgreSQL and Redis private.
5. Monitor `/health/ready`, `/metrics`, container logs, provider failures, and quota rejection rates.
6. Rotate application credentials when a consumer secret may be exposed.

### Backup and restore

The repository includes `scripts/backup-postgres.sh`:

```bash
DATABASE_URL='postgresql://gateway:password@localhost:5432/otp_gateway' \
  BACKUP_DIR=backups ./scripts/backup-postgres.sh
```

Schedule it with cron, encrypt or upload the resulting `.sql.gz` files to protected storage, and periodically test restores:

```bash
gunzip -c backups/otp-gateway-*.sql.gz | psql "$DATABASE_URL"
```

Backups contain usage and administrative data; protect them as sensitive data. Redis contains short-lived OTP state and is not a substitute for PostgreSQL backups.

## License

Private/internal project — add the organization’s license before publishing.
