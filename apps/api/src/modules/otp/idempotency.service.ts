import { AppError, ERROR_CODES } from "../../common/errors.js";
import { createHash } from "node:crypto";
import type { KeyValueStore } from "../../infrastructure/redis/store.js";

export interface IdempotentResponse {
  statusCode: number;
  body: unknown;
  fingerprint: string;
}

interface InFlightMarker {
  inFlight: true;
}

export class IdempotencyService {
  constructor(private readonly store: KeyValueStore, private readonly ttlSeconds: number) {}

  private key(applicationId: string, idempotencyKey: string): string {
    return `idem:${applicationId}:${idempotencyKey}`;
  }

  /**
   * Returns the stored response if this key was already processed,
   * null when the key is fresh (and claims it as in-flight).
   */
  async claim(applicationId: string, idempotencyKey: string, fingerprint: string): Promise<IdempotentResponse | null> {
    const key = this.key(applicationId, idempotencyKey);
    const stored = await this.store.getJson<IdempotentResponse | InFlightMarker>(key);
    if (stored) {
      if ("inFlight" in stored && stored.inFlight === true) {
        throw new AppError(
          ERROR_CODES.IDEMPOTENCY_IN_PROGRESS,
          "A request with this Idempotency-Key is currently in progress",
          409,
        );
      }
      if (!("statusCode" in stored)) return null;
      if (stored.fingerprint !== fingerprint) throw AppError.idempotencyKeyReused();
      return stored;
    }

    const claimed = await this.store.setIfNotExists(
      key,
      JSON.stringify({ inFlight: true }),
      this.ttlSeconds,
    );
    if (!claimed) {
      throw new AppError(
        ERROR_CODES.IDEMPOTENCY_IN_PROGRESS,
        "A request with this Idempotency-Key is currently in progress",
        409,
      );
    }
    return null;
  }

  async complete(
    applicationId: string,
    idempotencyKey: string,
    response: IdempotentResponse,
  ): Promise<void> {
    await this.store.setJson(this.key(applicationId, idempotencyKey), response, this.ttlSeconds);
  }

  static fingerprint(input: { phone: string; purpose: string }): string {
    return createHash("sha256").update(JSON.stringify(input)).digest("hex");
  }

  /** Release the claim on failure so the client can retry. */
  async release(applicationId: string, idempotencyKey: string): Promise<void> {
    await this.store.del(this.key(applicationId, idempotencyKey));
  }
}
