import type { PrismaClient } from "@prisma/client";

/**
 * Cost snapshot resolution: usage events store the price at the moment of
 * sending. Later price changes never affect recorded usage (see ProviderPrice).
 */
export class PricingService {
  constructor(private readonly prisma: PrismaClient) {}

  async resolvePrice(provider: { id: string; costPerSms: unknown }): Promise<number> {
    const latest = await this.prisma.providerPrice.findFirst({
      where: { providerId: provider.id, effectiveFrom: { lte: new Date() } },
      orderBy: { effectiveFrom: "desc" },
      select: { pricePerSms: true },
    });
    if (latest) return Number(latest.pricePerSms);
    return Number(provider.costPerSms);
  }
}
