import { PrismaClient } from "@prisma/client";
import type { Logger } from "../logging/logger.js";

let prisma: PrismaClient | null = null;

export function createPrismaClient(log: Logger): PrismaClient {
  if (prisma) return prisma;
  prisma = new PrismaClient({
    log: [
      { emit: "event", level: "warn" },
      { emit: "event", level: "error" },
    ],
  });
  prisma.$on("warn" as never, (e: unknown) => log.warn({ db: String((e as { message?: unknown }).message ?? e) }, "Prisma warning"));
  prisma.$on("error" as never, (e: unknown) => log.error({ db: String((e as { message?: unknown }).message ?? e) }, "Prisma error"));
  return prisma;
}

export function getPrisma(): PrismaClient {
  if (!prisma) throw new Error("Prisma client not initialized");
  return prisma;
}

export async function disconnectPrisma(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}

export async function checkDatabase(): Promise<boolean> {
  if (!prisma) return false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
