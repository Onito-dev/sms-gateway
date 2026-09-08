import { Redis } from "ioredis";

export function createRedisClient(url: string): Redis {
  const redis = new Redis(url, {
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => Math.min(times * 500, 5000),
    lazyConnect: false,
    enableOfflineQueue: false,
  });
  return redis;
}
