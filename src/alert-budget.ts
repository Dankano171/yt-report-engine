import { appendUsage, readUsage } from "./storage.js";
import type { AppConfig, UsageRecord } from "./types.js";

export interface AlertBudget {
  reserveUsd: (estimate: number) => boolean;
  onUsage: (record: UsageRecord) => Promise<void>;
}

export async function createAlertBudget(options: {
  config: AppConfig;
  now: Date;
  usagePath?: string;
}): Promise<AlertBudget> {
  const date = options.now.toISOString().slice(0, 10);
  const usagePath = options.usagePath ?? "usage_logs/usage.jsonl";
  const used = (await readUsage(usagePath))
    .filter((record) => record.date === date)
    .reduce((total, record) => total + record.estimatedUsd, 0);
  let actual = 0;
  let reserved = 0;
  const reservations: number[] = [];

  return {
    reserveUsd(estimate) {
      if (
        !Number.isFinite(estimate) ||
        estimate < 0 ||
        actual + reserved + estimate > options.config.limits.maxUsdPerRun ||
        used + actual + reserved + estimate > options.config.limits.maxUsdPerDay
      )
        return false;
      reserved += estimate;
      reservations.push(estimate);
      return true;
    },
    async onUsage(record) {
      const reservation = reservations.shift() ?? 0;
      reserved = Math.max(0, reserved - reservation);
      actual += record.estimatedUsd;
      const datedRecord = { ...record, date };
      await appendUsage(datedRecord, usagePath);
    },
  };
}
