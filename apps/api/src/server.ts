import { buildApp } from "./app.js";

const { app, container } = await buildApp();

const close = async (signal: string) => {
  container.logger.info({ signal }, "Shutdown requested");
  try {
    await app.close();
    await container.redis.quit();
    await container.prisma.$disconnect();
    container.logger.info("Shutdown complete");
    process.exit(0);
  } catch (error) {
    container.logger.error({ err: error }, "Graceful shutdown failed");
    process.exit(1);
  }
};

process.once("SIGTERM", () => void close("SIGTERM"));
process.once("SIGINT", () => void close("SIGINT"));

try {
  await app.listen({ port: container.config.port, host: "0.0.0.0" });
  container.logger.info({ port: container.config.port }, "Central OTP & SMS Gateway listening");
} catch (error) {
  container.logger.error({ err: error }, "Failed to start API");
  await container.redis.quit().catch(() => undefined);
  await container.prisma.$disconnect().catch(() => undefined);
  process.exit(1);
}
