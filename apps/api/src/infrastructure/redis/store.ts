/**
 * Minimal key/value port used by rate limiting, quotas, OTP storage,
 * idempotency and circuit-breaker state. Redis implements it in production;
 * tests use an in-memory implementation with identical semantics.
 */
export interface KeyValueStore {
  /** Increment counter and apply TTL (only when the key is new). Returns the new value. */
  incr(key: string, ttlSeconds: number): Promise<number>;
  /** Increment a float counter, applying TTL on first write. Returns the new value. */
  incrByFloat(key: string, value: number, ttlSeconds: number): Promise<number>;
  /** Atomically increment a float counter only when the resulting value stays within the limit. */
  incrByFloatIfBelow(key: string, increment: number, limit: number, ttlSeconds: number): Promise<{ allowed: boolean; current: number }>;
  /** Decrement a reservation counter without allowing it to go below zero. */
  decrBy(key: string, value: number): Promise<number>;
  /** Decrement a float reservation counter without allowing it to go below zero. */
  decrByFloat(key: string, value: number): Promise<number>;
  /** Atomically increment only while the current value is below the limit. */
  incrIfBelow(key: string, limit: number, ttlSeconds: number): Promise<{ allowed: boolean; current: number }>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Returns true if the key was claimed (i.e. it did not exist before). */
  setIfNotExists(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  getJson<T>(key: string): Promise<T | null>;
  setJson(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  /** Remaining TTL in seconds; -1 without expiry, -2 if missing. */
  ttl(key: string): Promise<number>;
  /** Acquire a short-lived distributed lock; returns an ownership token or null. */
  acquireLock(key: string, ttlSeconds: number): Promise<string | null>;
  /** Release a lock only when it is still owned by the supplied token. */
  releaseLock(key: string, token: string): Promise<void>;
}
