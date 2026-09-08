import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { KeyValueStore } from "./store.js";

export class RedisStore implements KeyValueStore {
  constructor(private readonly redis: Redis) {}

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const pipeline = this.redis.pipeline();
    pipeline.incr(key);
    pipeline.expire(key, ttlSeconds, "NX");
    const results = await pipeline.exec();
    const count = results?.[0]?.[1];
    return typeof count === "number" || typeof count === "string" ? Number(count) : 0;
  }

  async incrByFloat(key: string, value: number, ttlSeconds: number): Promise<number> {
    const pipeline = this.redis.pipeline();
    pipeline.incrbyfloat(key, value);
    pipeline.expire(key, ttlSeconds, "NX");
    const results = await pipeline.exec();
    const count = results?.[0]?.[1];
    return typeof count === "number" || typeof count === "string" ? Number(count) : 0;
  }

  async incrByFloatIfBelow(key: string, increment: number, limit: number, ttlSeconds: number): Promise<{ allowed: boolean; current: number }> {
    const script = `
      local current = redis.call('GET', KEYS[1])
      if not current then current = '0' end
      local next = tonumber(current) + tonumber(ARGV[1])
      if next > tonumber(ARGV[2]) then
        return {0, tonumber(current)}
      end
      redis.call('INCRBYFLOAT', KEYS[1], ARGV[1])
      if current == '0' then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
      return {1, next}
    `;
    const result = await this.redis.eval(script, 1, key, increment, limit, ttlSeconds) as [number, number];
    return { allowed: Number(result[0]) === 1, current: Number(result[1]) };
  }

  async decrBy(key: string, value: number): Promise<number> {
    const script = `
      local current = tonumber(redis.call('GET', KEYS[1]) or '0')
      local next = math.max(0, current - tonumber(ARGV[1]))
      if next == 0 then redis.call('DEL', KEYS[1]) else redis.call('SET', KEYS[1], next) end
      return next
    `;
    return Number(await this.redis.eval(script, 1, key, value));
  }

  async decrByFloat(key: string, value: number): Promise<number> {
    const script = `
      local current = tonumber(redis.call('GET', KEYS[1]) or '0')
      local next = math.max(0, current - tonumber(ARGV[1]))
      if next == 0 then redis.call('DEL', KEYS[1]) else redis.call('SET', KEYS[1], next) end
      return next
    `;
    return Number(await this.redis.eval(script, 1, key, value));
  }

  async incrIfBelow(key: string, limit: number, ttlSeconds: number): Promise<{ allowed: boolean; current: number }> {
    const script = `
      local current = redis.call('GET', KEYS[1])
      if not current then current = '0' end
      if tonumber(current) >= tonumber(ARGV[1]) then
        return {0, tonumber(current)}
      end
      local next = redis.call('INCR', KEYS[1])
      if next == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
      return {1, next}
    `;
    const result = await this.redis.eval(script, 1, key, limit, ttlSeconds) as [number, number];
    return { allowed: Number(result[0]) === 1, current: Number(result[1]) };
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, "EX", ttlSeconds);
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async setIfNotExists(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.redis.set(key, value, "EX", ttlSeconds, "NX");
    return result === "OK";
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  }

  async ttl(key: string): Promise<number> {
    return this.redis.ttl(key);
  }

  async acquireLock(key: string, ttlSeconds: number): Promise<string | null> {
    const token = randomUUID();
    const result = await this.redis.set(key, token, "EX", ttlSeconds, "NX");
    return result === "OK" ? token : null;
  }

  async releaseLock(key: string, token: string): Promise<void> {
    const script = `
      if redis.call('GET', KEYS[1]) == ARGV[1] then
        return redis.call('DEL', KEYS[1])
      end
      return 0
    `;
    await this.redis.eval(script, 1, key, token);
  }
}

export async function checkRedis(redis: Redis): Promise<boolean> {
  try {
    const result = await redis.ping();
    return result === "PONG";
  } catch {
    return false;
  }
}
