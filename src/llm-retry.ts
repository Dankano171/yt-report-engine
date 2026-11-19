export const BUYER_ALERT_RETRY_DELAYS_MS = [2_000, 5_000, 15_000] as const;

export function getRetryDelay(
  response: Response,
  retryIndex: number,
  delays: readonly number[],
): number {
  const retryAfter = response.headers.get("retry-after")?.trim();
  if (retryAfter) {
    if (/^\d+(?:\.\d+)?$/u.test(retryAfter))
      return Math.ceil(Number(retryAfter) * 1_000);
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) return Math.max(0, retryAt - Date.now());
  }
  return delays[retryIndex]!;
}
