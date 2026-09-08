import pino from "pino";

const SENSITIVE_KEYS = [
  "authorization",
  "x-api-key",
  "x-api-secret",
  "apiKey",
  "apiSecret",
  "api_secret",
  "secret",
  "password",
  "credentials",
  "credentialsEncrypted",
  "code",
  "otp",
  "token",
];

export function createLogger(level: string, env: string) {
  return pino({
    level,
    base: { service: "otp-sms-gateway", env },
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers['x-api-key']",
        "req.headers['x-api-secret']",
        ...SENSITIVE_KEYS.map((k) => `*.${k}`),
      ],
      censor: "[REDACTED]",
    },
    ...(env === "development"
      ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" } } }
      : {}),
  });
}

export type Logger = pino.Logger;
