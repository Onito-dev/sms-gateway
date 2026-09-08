import { PrismaClient } from "@prisma/client";
import { generateCredentialPair } from "../src/common/crypto.js";

const prisma = new PrismaClient();

const rateLimits = [
  { key: "ip_per_minute", scope: "IP" as const, limit: Number(process.env.RATE_LIMIT_IP_PER_MINUTE ?? 20), windowSeconds: 60, description: "Maximum OTP requests per source IP per minute" },
  { key: "app_per_minute", scope: "APPLICATION" as const, limit: Number(process.env.RATE_LIMIT_APP_PER_MINUTE ?? 100), windowSeconds: 60, description: "Maximum OTP requests per application per minute" },
  { key: "phone_per_10_minutes", scope: "PHONE" as const, limit: Number(process.env.RATE_LIMIT_PHONE_PER_10_MINUTES ?? 3), windowSeconds: 600, description: "Maximum OTP requests per phone number per ten minutes" },
  { key: "resend_cooldown_seconds", scope: "PHONE" as const, limit: Number(process.env.OTP_RESEND_COOLDOWN_SECONDS ?? 60), windowSeconds: Number(process.env.OTP_RESEND_COOLDOWN_SECONDS ?? 60), description: "Minimum seconds between successful OTP sends to one number" },
];

async function main(): Promise<void> {
  for (const config of rateLimits) {
    await prisma.rateLimitConfig.upsert({
      where: { key: config.key },
      update: {
        scope: config.scope,
        limit: config.limit,
        windowSeconds: config.windowSeconds,
        description: config.description,
        enabled: true,
      },
      create: config,
    });
  }

  const provider = await prisma.smsProvider.upsert({
    where: { name: "Local Mock Provider" },
    update: { status: "ACTIVE" },
    create: {
      name: "Local Mock Provider",
      type: "MOCK",
      priority: 1,
      weight: 100,
      costPerSms: 0,
      supportedCountries: ["*"],
      config: {},
      prices: { create: { pricePerSms: 0, currency: "USD" } },
    },
  });

  const appName = process.env.SEED_DEMO_APP_NAME ?? "Demo Application";
  const appSlug = process.env.SEED_DEMO_APP_SLUG ?? "demo-application";
  const existing = await prisma.application.findUnique({ where: { slug: appSlug }, include: { credentials: true } });

  if (!existing) {
    const pair = generateCredentialPair();
    const application = await prisma.application.create({
      data: {
        name: appName,
        slug: appSlug,
        description: "Seeded local application for development",
        providerStrategy: "AUTO",
        credentials: { create: { apiKey: pair.apiKey, secretHash: pair.secretHash } },
        quotas: {
          create: [
            { type: "DAILY_SMS", limit: 5000 },
            { type: "MONTHLY_SMS", limit: 100000 },
            { type: "DAILY_COST_USD", limit: 50 },
            { type: "MONTHLY_COST_USD", limit: 1000 },
          ],
        },
      },
    });
    console.log(`Seeded application: ${application.name}`);
    console.log(`API key (store securely): ${pair.apiKey}`);
    console.log(`API secret (shown once; store securely): ${pair.apiSecret}`);
  } else {
    console.log(`Application already exists: ${existing.name}; credentials were not regenerated.`);
  }
  console.log(`Seeded provider: ${provider.name}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
