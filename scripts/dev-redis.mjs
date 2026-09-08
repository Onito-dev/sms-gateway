/**
 * Starts an in-memory Redis (real redis-server binary, downloaded and cached by
 * redis-memory-server) on a local port and prints the connection URI.
 * Used for the local preview / dev loop where Docker is unavailable.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const RedisMemoryServer = require("../.freebuff/tools/node_modules/redis-memory-server/lib/index.js").default ?? require("../.freebuff/tools/node_modules/redis-memory-server/lib/index.js");

const redis = new RedisMemoryServer({
  instance: { port: 6379, ip: "127.0.0.1" },
});

const host = await redis.getHost();
const port = await redis.getPort();
console.log(`redis-memory-server ready at redis://${host}:${port}`);

const shutdown = async (signal) => {
  console.log(`received ${signal}, stopping redis`);
  await redis.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
setInterval(() => undefined, 1 << 30); // keep the event loop alive
