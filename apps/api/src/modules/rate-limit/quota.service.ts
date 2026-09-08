import { AppError } from "../../common/errors.js";
import type { KeyValueStore } from "../../infrastructure/redis/store.js";

export interface QuotaLimit {
  type: "DAILY_SMS" | "MONTHLY_SMS" | "DAILY_COST_USD" | "MONTHLY_COST_USD";
  limit: number;
  enabled: boolean;
}

const DAY_TTL = 60 * 60 * 48; // 48h — counters outlive the calendar window
const MONTH_TTL = 60 * 60 * 24 * 40;

export interface QuotaReservation {
  smsDailyKey: string;
  smsMonthlyKey: string;
  costDailyKey: string;
  costMonthlyKey: string;
  estimatedCostUsd: number;
}

function dayPeriod(now = new Date()): string {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

function monthPeriod(now = new Date()): string {
  return now.toISOString().slice(0, 7); // YYYY-MM
}

/**
 * Quota enforcement with Redis counters. Counters are incremented *after*
 * a successful send, and checked *before* sending. A tiny overshoot is
 * possible under concurrent requests — acceptable for cost protection.
 */
export class QuotaService {
  constructor(private readonly store: KeyValueStore) {}

  async assertSmsQuotaAvailable(applicationId: string, quotas: QuotaLimit[]): Promise<void> {
    const day = dayPeriod();
    const month = monthPeriod();

    for (const quota of quotas) {
      if (!quota.enabled) continue;
      switch (quota.type) {
        case "DAILY_SMS": {
          const used = await this.smsUsed(applicationId, day);
          if (used >= quota.limit) {
            throw AppError.quotaExceeded("Daily SMS quota exceeded for this application");
          }
          break;
        }
        case "MONTHLY_SMS": {
          const used = await this.smsUsed(applicationId, month);
          if (used >= quota.limit) {
            throw AppError.quotaExceeded("Monthly SMS quota exceeded for this application");
          }
          break;
        }
        case "DAILY_COST_USD": {
          const used = await this.costUsed(applicationId, day);
          if (used >= quota.limit) {
            throw AppError.quotaExceeded("Daily cost limit exceeded for this application");
          }
          break;
        }
        case "MONTHLY_COST_USD": {
          const used = await this.costUsed(applicationId, month);
          if (used >= quota.limit) {
            throw AppError.quotaExceeded("Monthly cost limit exceeded for this application");
          }
          break;
        }
        default:
          break;
      }
    }
  }

  /**
   * Atomically reserve one SMS and its estimated cost before provider send.
   * This closes the check-then-send race between concurrent OTP requests.
   */
  async reserveSmsQuota(
    applicationId: string,
    quotas: QuotaLimit[],
    estimatedCostUsd: number,
    now = new Date(),
  ): Promise<QuotaReservation> {
    const day = dayPeriod(now);
    const month = monthPeriod(now);
    const smsDailyKey = `quota:sms:${applicationId}:${day}`;
    const smsMonthlyKey = `quota:sms:${applicationId}:${month}`;
    const costDailyKey = `quota:cost:${applicationId}:${day}`;
    const costMonthlyKey = `quota:cost:${applicationId}:${month}`;
    const safeCost = Number.isFinite(estimatedCostUsd) && estimatedCostUsd > 0 ? estimatedCostUsd : 0;
    const dailySmsLimit = quotas.find((quota) => quota.enabled && quota.type === "DAILY_SMS")?.limit;
    const monthlySmsLimit = quotas.find((quota) => quota.enabled && quota.type === "MONTHLY_SMS")?.limit;
    const dailyCostLimit = quotas.find((quota) => quota.enabled && quota.type === "DAILY_COST_USD")?.limit;
    const monthlyCostLimit = quotas.find((quota) => quota.enabled && quota.type === "MONTHLY_COST_USD")?.limit;
    const increments: Array<{ key: string; value: number; float: boolean }> = [];

    try {
      await this.reserveInteger(smsDailyKey, 1, dailySmsLimit, DAY_TTL);
      increments.push({ key: smsDailyKey, value: 1, float: false });
      await this.reserveInteger(smsMonthlyKey, 1, monthlySmsLimit, MONTH_TTL);
      increments.push({ key: smsMonthlyKey, value: 1, float: false });
      await this.reserveCost(costDailyKey, safeCost, dailyCostLimit, DAY_TTL);
      if (safeCost > 0) increments.push({ key: costDailyKey, value: safeCost, float: true });
      await this.reserveCost(costMonthlyKey, safeCost, monthlyCostLimit, MONTH_TTL);
      if (safeCost > 0) increments.push({ key: costMonthlyKey, value: safeCost, float: true });
      return { smsDailyKey, smsMonthlyKey, costDailyKey, costMonthlyKey, estimatedCostUsd: safeCost };
    } catch (error) {
      await this.rollback(increments);
      throw error;
    }
  }

  /** Commit a reservation to the actual provider cost; SMS count remains one. */
  async settleReservation(reservation: QuotaReservation, actualCostUsd: number): Promise<void> {
    const safeActual = Number.isFinite(actualCostUsd) && actualCostUsd > 0 ? actualCostUsd : 0;
    const delta = safeActual - reservation.estimatedCostUsd;
    if (delta > 0) {
      await this.store.incrByFloat(reservation.costDailyKey, delta, DAY_TTL);
      await this.store.incrByFloat(reservation.costMonthlyKey, delta, MONTH_TTL);
    } else if (delta < 0) {
      await this.store.decrByFloat(reservation.costDailyKey, Math.abs(delta));
      await this.store.decrByFloat(reservation.costMonthlyKey, Math.abs(delta));
    }
  }

  /** Roll back a reservation when the message was not accepted by any provider. */
  async releaseReservation(reservation: QuotaReservation): Promise<void> {
    await this.rollback([
      { key: reservation.smsDailyKey, value: 1, float: false },
      { key: reservation.smsMonthlyKey, value: 1, float: false },
      ...(reservation.estimatedCostUsd > 0 ? [
        { key: reservation.costDailyKey, value: reservation.estimatedCostUsd, float: true },
        { key: reservation.costMonthlyKey, value: reservation.estimatedCostUsd, float: true },
      ] : []),
    ]);
  }

  /** Backwards-compatible non-atomic post-send accounting helper. */
  async recordUsage(
    applicationId: string,
    costUsd: number,
    now = new Date(),
  ): Promise<void> {
    const day = dayPeriod(now);
    const month = monthPeriod(now);
    await this.store.incr(`quota:sms:${applicationId}:${day}`, DAY_TTL);
    await this.store.incr(`quota:sms:${applicationId}:${month}`, MONTH_TTL);
    await this.store.incrByFloat(`quota:cost:${applicationId}:${day}`, costUsd, DAY_TTL);
    await this.store.incrByFloat(`quota:cost:${applicationId}:${month}`, costUsd, MONTH_TTL);
  }

  /** Current usage snapshot (for the admin panel). */
  async getUsage(applicationId: string): Promise<{
    dailySms: number;
    monthlySms: number;
    dailyCostUsd: number;
    monthlyCostUsd: number;
  }> {
    const day = dayPeriod();
    const month = monthPeriod();
    const [dailySms, monthlySms, dailyCost, monthlyCost] = await Promise.all([
      this.smsUsed(applicationId, day),
      this.smsUsed(applicationId, month),
      this.costUsed(applicationId, day),
      this.costUsed(applicationId, month),
    ]);
    return { dailySms, monthlySms, dailyCostUsd: dailyCost, monthlyCostUsd: monthlyCost };
  }

  private async reserveInteger(key: string, increment: number, limit: number | undefined, ttlSeconds: number): Promise<void> {
    if (limit === undefined) {
      await this.store.incr(key, ttlSeconds);
      return;
    }
    const result = await this.store.incrIfBelow(key, limit, ttlSeconds);
    if (!result.allowed) throw AppError.quotaExceeded("SMS quota exceeded for this application");
  }

  private async reserveCost(key: string, increment: number, limit: number | undefined, ttlSeconds: number): Promise<void> {
    if (increment <= 0) return;
    if (limit === undefined) {
      await this.store.incrByFloat(key, increment, ttlSeconds);
      return;
    }
    const result = await this.store.incrByFloatIfBelow(key, increment, limit, ttlSeconds);
    if (!result.allowed) throw AppError.quotaExceeded("Cost quota exceeded for this application");
  }

  private async rollback(increments: Array<{ key: string; value: number; float: boolean }>): Promise<void> {
    for (const increment of increments.reverse()) {
      try {
        if (increment.float) await this.store.decrByFloat(increment.key, increment.value);
        else await this.store.decrBy(increment.key, increment.value);
      } catch {
        // A failed rollback is observable through the quota counter and should
        // fail closed rather than creating another send opportunity.
      }
    }
  }

  private async smsUsed(applicationId: string, period: string): Promise<number> {
    const raw = await this.store.get(`quota:sms:${applicationId}:${period}`);
    return raw ? Number(raw) : 0;
  }

  private async costUsed(applicationId: string, period: string): Promise<number> {
    const raw = await this.store.get(`quota:cost:${applicationId}:${period}`);
    return raw ? Number(raw) : 0;
  }
}
