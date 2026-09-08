import { z } from "zod";

const intFromEnv = (defaultValue: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? defaultValue : Number(v)))
    .pipe(z.number().int().positive());

const numFromEnv = (defaultValue: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? defaultValue : Number(v)))
    .pipe(z.number().positive());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: intFromEnv(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  // Master key for credential encryption & OTP hashing (32+ random chars).
  MASTER_KEY: z.string().min(32),
  // Bearer token for the admin API.
  ADMIN_TOKEN: z.string().min(16),
  CORS_ORIGINS: z.string().default("http://localhost:5173"),

  // OTP policy defaults (overridable per application)
  OTP_LENGTH: intFromEnv(6),
  OTP_TTL_SECONDS: intFromEnv(120),
  OTP_MAX_ATTEMPTS: intFromEnv(5),
  OTP_RESEND_COOLDOWN_SECONDS: intFromEnv(60),
  DEFAULT_OTP_MESSAGE: z.string().default("Your verification code is: {{code}}"),

  // Rate limit defaults (overridable per application / via admin UI)
  RATE_LIMIT_IP_PER_MINUTE: intFromEnv(20),
  RATE_LIMIT_APP_PER_MINUTE: intFromEnv(100),
  RATE_LIMIT_PHONE_PER_10_MINUTES: intFromEnv(3),

  // Abuse prevention
  MAX_PROVIDER_FAILOVER: intFromEnv(2),
  CIRCUIT_BREAKER_THRESHOLD: intFromEnv(5),
  CIRCUIT_BREAKER_COOLDOWN_SECONDS: intFromEnv(60),
  IDEMPOTENCY_TTL_SECONDS: intFromEnv(600),

  // Phone normalization default country (ISO code from the COUNTRIES registry)
  DEFAULT_COUNTRY: z.string().default("IR"),
});

export type Env = z.infer<typeof envSchema>;

export function parseConfig(environment: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.safeParse(environment);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}

export function loadConfig(): Env {
  return parseConfig(process.env);
}

export type AppConfig = {
  env: Env["NODE_ENV"];
  port: number;
  logLevel: Env["LOG_LEVEL"];
  corsOrigins: string[];
  defaultCountry: string;
  otp: {
    length: number;
    ttlSeconds: number;
    maxAttempts: number;
    resendCooldownSeconds: number;
    messageTemplate: string;
  };
  rateLimits: {
    ipPerMinute: number;
    appPerMinute: number;
    phonePer10Minutes: number;
  };
  failover: {
    maxProviderFailover: number;
    circuitBreakerThreshold: number;
    circuitBreakerCooldownSeconds: number;
  };
  idempotencyTtlSeconds: number;
};

export function buildConfig(env: Env): AppConfig {
  return {
    env: env.NODE_ENV,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    corsOrigins: env.CORS_ORIGINS.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    defaultCountry: env.DEFAULT_COUNTRY.toUpperCase(),
    otp: {
      length: env.OTP_LENGTH,
      ttlSeconds: env.OTP_TTL_SECONDS,
      maxAttempts: env.OTP_MAX_ATTEMPTS,
      resendCooldownSeconds: env.OTP_RESEND_COOLDOWN_SECONDS,
      messageTemplate: env.DEFAULT_OTP_MESSAGE,
    },
    rateLimits: {
      ipPerMinute: env.RATE_LIMIT_IP_PER_MINUTE,
      appPerMinute: env.RATE_LIMIT_APP_PER_MINUTE,
      phonePer10Minutes: env.RATE_LIMIT_PHONE_PER_10_MINUTES,
    },
    failover: {
      maxProviderFailover: env.MAX_PROVIDER_FAILOVER,
      circuitBreakerThreshold: env.CIRCUIT_BREAKER_THRESHOLD,
      circuitBreakerCooldownSeconds: env.CIRCUIT_BREAKER_COOLDOWN_SECONDS,
    },
    idempotencyTtlSeconds: env.IDEMPOTENCY_TTL_SECONDS,
  };
}
