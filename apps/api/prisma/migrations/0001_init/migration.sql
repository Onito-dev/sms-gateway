-- Central OTP & SMS Gateway initial schema

CREATE TYPE "ApplicationStatus" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "ProviderStrategy" AS ENUM ('PRIORITY', 'CHEAPEST', 'WEIGHTED', 'AUTO');
CREATE TYPE "CredentialStatus" AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE "ProviderStatus" AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE "ProviderHealthStatus" AS ENUM ('HEALTHY', 'DEGRADED', 'DOWN', 'UNKNOWN');
CREATE TYPE "OtpRequestStatus" AS ENUM ('PENDING', 'SENT', 'VERIFIED', 'FAILED', 'EXPIRED');
CREATE TYPE "UsageStatus" AS ENUM ('SUCCESS', 'FAILED', 'REJECTED', 'RATE_LIMITED', 'QUOTA_EXCEEDED');
CREATE TYPE "RateLimitScope" AS ENUM ('IP', 'APPLICATION', 'PHONE');
CREATE TYPE "QuotaType" AS ENUM ('DAILY_SMS', 'MONTHLY_SMS', 'DAILY_COST_USD', 'MONTHLY_COST_USD');

CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'ACTIVE',
    "allowedCountries" TEXT[] NOT NULL DEFAULT ARRAY['*']::TEXT[],
    "otpPolicy" JSONB,
    "rateLimits" JSONB,
    "providerStrategy" "ProviderStrategy" NOT NULL DEFAULT 'AUTO',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SmsProvider" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" "ProviderStatus" NOT NULL DEFAULT 'ACTIVE',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "costPerSms" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "credentialsEncrypted" TEXT,
    "config" JSONB,
    "timeoutMs" INTEGER NOT NULL DEFAULT 10000,
    "maxRetries" INTEGER NOT NULL DEFAULT 0,
    "supportedCountries" TEXT[] NOT NULL DEFAULT ARRAY['*']::TEXT[],
    "healthStatus" "ProviderHealthStatus" NOT NULL DEFAULT 'UNKNOWN',
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "lastHealthCheckAt" TIMESTAMP(3),
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "avgResponseMs" INTEGER NOT NULL DEFAULT 0,
    "circuitOpenUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SmsProvider_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ApplicationCredential" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "status" "CredentialStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    CONSTRAINT "ApplicationCredential_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderPrice" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "pricePerSms" DECIMAL(12,6) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProviderPrice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OtpRequest" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "providerId" TEXT,
    "status" "OtpRequestStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OtpRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UsageEvent" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "providerId" TEXT,
    "otpRequestId" TEXT,
    "phoneCountry" TEXT NOT NULL,
    "smsCount" INTEGER NOT NULL DEFAULT 1,
    "status" "UsageStatus" NOT NULL,
    "providerCost" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RateLimitConfig" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "scope" "RateLimitScope" NOT NULL,
    "limit" INTEGER NOT NULL,
    "windowSeconds" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RateLimitConfig_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Quota" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "type" "QuotaType" NOT NULL,
    "limit" DECIMAL(14,4) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "Quota_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "resourceId" TEXT,
    "ip" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applicationId" TEXT,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Application_name_key" ON "Application"("name");
CREATE UNIQUE INDEX "Application_slug_key" ON "Application"("slug");
CREATE INDEX "Application_status_idx" ON "Application"("status");

CREATE UNIQUE INDEX "SmsProvider_name_key" ON "SmsProvider"("name");
CREATE INDEX "SmsProvider_status_priority_idx" ON "SmsProvider"("status", "priority");

CREATE UNIQUE INDEX "ApplicationCredential_apiKey_key" ON "ApplicationCredential"("apiKey");
CREATE INDEX "ApplicationCredential_applicationId_status_idx" ON "ApplicationCredential"("applicationId", "status");

CREATE INDEX "ProviderPrice_providerId_effectiveFrom_idx" ON "ProviderPrice"("providerId", "effectiveFrom");
CREATE INDEX "OtpRequest_applicationId_phone_createdAt_idx" ON "OtpRequest"("applicationId", "phone", "createdAt");
CREATE INDEX "OtpRequest_applicationId_createdAt_idx" ON "OtpRequest"("applicationId", "createdAt");
CREATE INDEX "OtpRequest_status_idx" ON "OtpRequest"("status");

CREATE INDEX "UsageEvent_applicationId_createdAt_idx" ON "UsageEvent"("applicationId", "createdAt");
CREATE INDEX "UsageEvent_providerId_createdAt_idx" ON "UsageEvent"("providerId", "createdAt");
CREATE INDEX "UsageEvent_status_createdAt_idx" ON "UsageEvent"("status", "createdAt");
CREATE INDEX "UsageEvent_createdAt_idx" ON "UsageEvent"("createdAt");

CREATE UNIQUE INDEX "RateLimitConfig_key_key" ON "RateLimitConfig"("key");
CREATE UNIQUE INDEX "Quota_applicationId_type_key" ON "Quota"("applicationId", "type");
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
CREATE INDEX "AuditLog_resource_resourceId_idx" ON "AuditLog"("resource", "resourceId");

ALTER TABLE "ApplicationCredential" ADD CONSTRAINT "ApplicationCredential_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderPrice" ADD CONSTRAINT "ProviderPrice_providerId_fkey"
  FOREIGN KEY ("providerId") REFERENCES "SmsProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OtpRequest" ADD CONSTRAINT "OtpRequest_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_providerId_fkey"
  FOREIGN KEY ("providerId") REFERENCES "SmsProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_otpRequestId_fkey"
  FOREIGN KEY ("otpRequestId") REFERENCES "OtpRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Quota" ADD CONSTRAINT "Quota_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE SET NULL ON UPDATE CASCADE;
