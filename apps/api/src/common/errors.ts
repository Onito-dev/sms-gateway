/**
 * Stable application error codes — never rename these, clients depend on them.
 */
export const ERROR_CODES = {
  INVALID_PHONE: "INVALID_PHONE",
  COUNTRY_NOT_ALLOWED: "COUNTRY_NOT_ALLOWED",
  OTP_RATE_LIMITED: "OTP_RATE_LIMITED",
  OTP_EXPIRED: "OTP_EXPIRED",
  OTP_INVALID: "OTP_INVALID",
  OTP_MAX_ATTEMPTS: "OTP_MAX_ATTEMPTS",
  OTP_NOT_FOUND: "OTP_NOT_FOUND",
  APPLICATION_DISABLED: "APPLICATION_DISABLED",
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  NO_PROVIDER_AVAILABLE: "NO_PROVIDER_AVAILABLE",
  PROVIDER_ERROR: "PROVIDER_ERROR",
  PROVIDER_TIMEOUT: "PROVIDER_TIMEOUT",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  IDEMPOTENCY_IN_PROGRESS: "IDEMPOTENCY_IN_PROGRESS",
  IDEMPOTENCY_KEY_REUSED: "IDEMPOTENCY_KEY_REUSED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, statusCode: number, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }

  static invalidPhone(message = "Invalid phone number"): AppError {
    return new AppError(ERROR_CODES.INVALID_PHONE, message, 400);
  }

  static countryNotAllowed(country: string): AppError {
    return new AppError(
      ERROR_CODES.COUNTRY_NOT_ALLOWED,
      `Country ${country} is not allowed for this application`,
      403,
    );
  }

  static rateLimited(message = "Too many OTP requests"): AppError {
    return new AppError(ERROR_CODES.OTP_RATE_LIMITED, message, 429);
  }

  static quotaExceeded(message = "Quota exceeded"): AppError {
    return new AppError(ERROR_CODES.QUOTA_EXCEEDED, message, 429);
  }

  static otpExpired(message = "OTP has expired"): AppError {
    return new AppError(ERROR_CODES.OTP_EXPIRED, message, 410);
  }

  static otpInvalid(message = "Invalid OTP code"): AppError {
    return new AppError(ERROR_CODES.OTP_INVALID, message, 400);
  }

  static otpMaxAttempts(message = "Maximum verification attempts reached"): AppError {
    return new AppError(ERROR_CODES.OTP_MAX_ATTEMPTS, message, 400);
  }

  static noProviderAvailable(): AppError {
    return new AppError(
      ERROR_CODES.NO_PROVIDER_AVAILABLE,
      "No SMS provider is currently available",
      503,
    );
  }

  static unauthorized(message = "Missing or invalid credentials"): AppError {
    return new AppError(ERROR_CODES.UNAUTHORIZED, message, 401);
  }

  static forbidden(message = "Access denied"): AppError {
    return new AppError(ERROR_CODES.FORBIDDEN, message, 403);
  }

  static notFound(message = "Resource not found"): AppError {
    return new AppError(ERROR_CODES.NOT_FOUND, message, 404);
  }

  static conflict(message = "Conflict"): AppError {
    return new AppError(ERROR_CODES.CONFLICT, message, 409);
  }

  static idempotencyKeyReused(): AppError {
    return new AppError(
      ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
      "Idempotency-Key was already used for a different request",
      409,
    );
  }

  static validation(message: string, details?: unknown): AppError {
    return new AppError(ERROR_CODES.VALIDATION_ERROR, message, 400, details);
  }
}
