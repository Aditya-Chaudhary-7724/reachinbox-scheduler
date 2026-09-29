import type { Redis } from 'ioredis';
import { env } from '../config/env';
import { CONSUME_HOURLY_QUOTA_LUA } from './lua/consumeHourlyQuota';

const HOUR_MS = 60 * 60 * 1000;
const COUNTER_TTL_SECONDS = 2 * 60 * 60;
/** Safety bound when rolling deferrals forward through full hours (30 days). */
const MAX_ROLLOVER_HOURS = 24 * 30;

// ---------------------------------------------------------------------------
// Pure helpers (UTC hour windows)
// ---------------------------------------------------------------------------

export interface HourWindow {
  /** Hours since the Unix epoch. */
  index: number;
  /** YYYYMMDDHH in UTC, used in Redis keys. */
  key: string;
  start: Date;
  end: Date;
}

export function hourWindow(index: number): HourWindow {
  const start = new Date(index * HOUR_MS);
  const key = start.toISOString().slice(0, 13).replace(/[-T]/g, '');
  return { index, key, start, end: new Date(start.getTime() + HOUR_MS) };
}

export function hourWindowAt(timeMs: number): HourWindow {
  return hourWindow(Math.floor(timeMs / HOUR_MS));
}

/** The effective per-sender limit: the stricter of the campaign's and the global env cap. */
export function effectiveHourlyLimit(campaignLimit: number, maxPerSender: number): number {
  return Math.max(1, Math.min(campaignLimit, maxPerSender));
}

/**
 * Run time for the n-th (1-based) deferred email in a window: slots are spaced by the
 * minimum send interval from the start of the hour, so deferred emails keep their order.
 */
export function slotRunAt(window: HourWindow, slot: number, intervalMs: number): Date {
  return new Date(window.start.getTime() + (slot - 1) * intervalMs);
}

// ---------------------------------------------------------------------------
// Redis-backed operations
// ---------------------------------------------------------------------------

export type Scope = { kind: 'sender'; senderId: string } | { kind: 'global' };

const scopeId = (scope: Scope) => (scope.kind === 'sender' ? scope.senderId : 'global');
export const quotaKey = (scope: Scope, window: HourWindow) => `rl:${scopeId(scope)}:${window.key}`;
export const deferKey = (scope: Scope, window: HourWindow) =>
  `rl:defer:${scopeId(scope)}:${window.key}`;

export type QuotaDecision =
  | { allowed: true; count: number; window: HourWindow }
  | { allowed: false; deniedBy: Scope; limit: number; count: number; window: HourWindow };

type RedisWithQuota = Redis & {
  consumeHourlyQuota(
    senderKey: string,
    globalKey: string,
    senderLimit: number,
    globalLimit: number,
    ttlSeconds: number,
  ): Promise<[number, number, number]>;
};

function withQuotaCommand(redis: Redis): RedisWithQuota {
  const r = redis as RedisWithQuota;
  if (typeof r.consumeHourlyQuota !== 'function') {
    r.defineCommand('consumeHourlyQuota', { numberOfKeys: 2, lua: CONSUME_HOURLY_QUOTA_LUA });
  }
  return r;
}

export interface QuotaRequest {
  senderId: string;
  senderLimit: number;
  /** Global cap across all senders; undefined disables it. */
  globalLimit?: number;
  now?: number;
}

/** Atomically takes one send from the current UTC hour's quota, or reports who denied it. */
export async function consumeHourlyQuota(redis: Redis, req: QuotaRequest): Promise<QuotaDecision> {
  const window = hourWindowAt(req.now ?? Date.now());
  const sender: Scope = { kind: 'sender', senderId: req.senderId };
  const global: Scope = { kind: 'global' };
  const [allowed, deniedBy, count] = await withQuotaCommand(redis).consumeHourlyQuota(
    quotaKey(sender, window),
    quotaKey(global, window),
    req.senderLimit,
    req.globalLimit ?? 0,
    COUNTER_TTL_SECONDS,
  );
  if (allowed === 1) return { allowed: true, count, window };
  return deniedBy === 2
    ? { allowed: false, deniedBy: global, limit: req.globalLimit ?? 0, count, window }
    : { allowed: false, deniedBy: sender, limit: req.senderLimit, count, window };
}

export interface DeferralSlot {
  window: HourWindow;
  slot: number;
  runAt: Date;
}

/**
 * Reserves an ordered slot in the next hour window with capacity. INCR hands out slot
 * numbers atomically, so concurrent deferrals across workers never share a slot and
 * earlier-deferred emails run first. If the next hour's slots are all taken, the search
 * rolls forward hour by hour.
 */
export async function reserveDeferralSlot(
  redis: Redis,
  scope: Scope,
  capacity: number,
  now = Date.now(),
  intervalMs = env.MIN_SEND_INTERVAL_MS,
): Promise<DeferralSlot> {
  const current = hourWindowAt(now);
  for (let offset = 1; offset <= MAX_ROLLOVER_HOURS; offset++) {
    const window = hourWindow(current.index + offset);
    const key = deferKey(scope, window);
    const slot = await redis.incr(key);
    if (slot === 1) {
      // Keep the counter until an hour after its window closes.
      const ttlSeconds = Math.ceil((window.end.getTime() - now) / 1000) + 3600;
      await redis.expire(key, ttlSeconds);
    }
    if (slot <= capacity) {
      return { window, slot, runAt: slotRunAt(window, slot, intervalMs) };
    }
  }
  throw new Error(`No deferral slot available within ${MAX_ROLLOVER_HOURS} hours`);
}

/**
 * True only for the first caller per (user, scope, hour): guards the Slack alert so it
 * fires once per sender per window, even with many workers hitting the limit at once.
 */
export async function claimLimitNotification(
  redis: Redis,
  userId: string,
  scope: Scope,
  window: HourWindow,
): Promise<boolean> {
  const key = `rl:notified:${userId}:${scopeId(scope)}:${window.key}`;
  return (await redis.set(key, '1', 'EX', 3600, 'NX')) === 'OK';
}
