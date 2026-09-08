/**
 * Starts an embedded PostgreSQL for the local preview / dev loop where a
 * system Postgres or Docker is unavailable. The data directory is cached
 * under .freebuff/pgdata so repeated starts are fast. On a fresh data
 * directory it runs `prisma migrate deploy` + `prisma db seed`.
 *
 * Connection: postgresql://gateway:gateway@127.0.0.1:5432/otp_gateway
 */
import { createRequire } from "node:module";
import { mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const EmbeddedPostgres = require("../.freebuff/tools/node_modules/embedded-postgres/dist/index.js").default ??
  require("../.freebuff/tools/node_modules/embedded-postgres/dist/index.js");

const PORT = 5432;
// Password must match DATABASE_URL in .env (gateway_password).
const PASSWORD = "gateway_password";
const DATA_DIR = join(__dirname, "..", ".freebuff", "pgdata");
mkdirSync(DATA_DIR, { recursive: true });

const fresh = !existsSync(join(DATA_DIR, "PG_VERSION"));

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: "gateway",
  password: PASSWORD,
  port: PORT,
  persistent: true,
  // The host locale (e.g. Persian_Iran.1256) has no matching initdb text
  // search configuration — force a universally available one.
  locale: "en_US",
});

const shutdown = async (signal) => {
  console.log(`received ${signal}, stopping postgres`);
  try { await pg.stop(); } catch { /* already stopped */ }
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// initialise() fails when the data directory already exists — only run it
// on a truly fresh dir (cached dir keeps PG_VERSION from the previous run).
if (fresh) {
  await pg.initialise();
}
await pg.start();
await pg.createDatabase("otp_gateway").catch(() => undefined);
console.log(`embedded postgres ready at 127.0.0.1:${PORT} (fresh=${fresh})`);

if (fresh) {
  const repoRoot = join(__dirname, "..");
  const env = {
    ...process.env,
    DATABASE_URL: `postgresql://gateway:${PASSWORD}@127.0.0.1:${PORT}/otp_gateway?schema=public`,
  };
  // Run migrations via the Prisma CLI's JS bin directly (no npx/cmd shim,
  // which fails with EINVAL in detached PowerShell sessions on Windows).
  console.log("running prisma migrate deploy...");
  execFileSync(process.execPath, [join(repoRoot, "node_modules", "prisma", "build", "index.js"), "migrate", "deploy"], {
    cwd: join(repoRoot, "apps", "api"),
    env,
    stdio: "inherit",
  });
  console.log("running prisma db seed...");
  execFileSync(process.execPath, ["--import", "tsx", join(repoRoot, "apps", "api", "prisma", "seed.ts")], {
    cwd: join(repoRoot, "apps", "api"),
    env,
    stdio: "inherit",
  });
  console.log("database initialised");
}

setInterval(() => undefined, 1 << 30); // keep the event loop alive
