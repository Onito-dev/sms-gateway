#!/usr/bin/env node
/**
 * Production start for container/PaaS deploys (Coolify, Railpack, Docker).
 *
 * Why this exists: `prisma migrate deploy` fails hard when the database is
 * not reachable yet (orchestrators race containers at boot) or when required
 * env vars are missing — turning startup into a crash-restart loop with an
 * opaque Prisma error. This script:
 *
 *   1. Validates required environment variables and fails fast with a clear
 *      list of what is missing.
 *   2. Waits for the database to accept TCP connections (default 60s).
 *   3. Runs `prisma migrate deploy` with retries for transient failures.
 *   4. Starts the API (node dist/server.js) and forwards signals.
 *
 * Required env: DATABASE_URL, REDIS_URL, MASTER_KEY, ADMIN_TOKEN
 * (see .env.example for the full list).
 */
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.join(__dirname, "..", "apps", "api");

const REQUIRED = ["DATABASE_URL", "REDIS_URL", "MASTER_KEY", "ADMIN_TOKEN"];
const missing = REQUIRED.filter((k) => !process.env[k] || process.env[k].length === 0);
if (missing.length > 0) {
  console.error(`[start] Missing required environment variables: ${missing.join(", ")}`);
  console.error("[start] Set them in the deployment environment (Coolify → Environment). See .env.example.");
  process.exit(1);
}

function dbTarget() {
  try {
    const u = new URL(process.env.DATABASE_URL);
    return { host: u.hostname || "127.0.0.1", port: Number(u.port || 5432) };
  } catch {
    return null;
  }
}

function tryConnect({ host, port }, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: timeoutMs });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function waitForDb(maxMs = 60_000) {
  const target = dbTarget();
  if (!target) {
    console.error("[start] DATABASE_URL is not a valid connection URL");
    process.exit(1);
  }
  console.log(`[start] Waiting for database at ${target.host}:${target.port}...`);
  const deadline = Date.now() + maxMs;
  for (;;) {
    if (await tryConnect(target)) {
      console.log(`[start] Database reachable at ${target.host}:${target.port}`);
      return;
    }
    if (Date.now() > deadline) {
      console.error(
        `[start] Database not reachable at ${target.host}:${target.port} after ${maxMs / 1000}s. ` +
          "If this is a container, use the service hostname (e.g. postgres), not localhost.",
      );
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

await waitForDb();

let migrated = false;
for (let attempt = 1; attempt <= 3 && !migrated; attempt++) {
  try {
    console.log(`[start] Running prisma migrate deploy (attempt ${attempt}/3)...`);
    execFileSync("npx", ["--no-install", "prisma", "migrate", "deploy"], {
      cwd: apiDir,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    migrated = true;
  } catch {
    if (attempt === 3) {
      console.error("[start] prisma migrate deploy failed after retries. Check DATABASE_URL credentials and database logs.");
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

console.log("[start] Starting API...");
const server = spawn(process.execPath, ["dist/server.js"], { cwd: apiDir, stdio: "inherit" });

const forward = (signal) => {
  if (!server.killed) server.kill(signal);
};
process.on("SIGTERM", () => forward("SIGTERM"));
process.on("SIGINT", () => forward("SIGINT"));

server.on("exit", (code) => process.exit(code ?? 1));
