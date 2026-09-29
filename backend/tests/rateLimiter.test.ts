import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { redis } from '../src/queue/connection';
import {
  claimLimitNotification,
  consumeHourlyQuota,
  hourWindowAt,
  quotaKey,
  reserveDeferralSlot,
} from '../src/queue/rateLimiter';
import { uid } from './helpers';

const NOW = Date.parse('2026-03-07T14:20:00Z');

beforeEach(async () => {
  await redis.flushdb(); // DB 15 is reserved for tests (see vitest.config.mts)
});

afterAll(async () => {
  await redis.quit();
});

describe('consumeHourlyQuota (Lua, real Redis)', () => {
  it('allows up to the limit, then denies without incrementing', async () => {
    const senderId = uid();
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(await consumeHourlyQuota(redis, { senderId, senderLimit: 3, now: NOW }));
    }
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
    const denied = results[3];
    expect(denied?.allowed === false && denied.deniedBy).toEqual({ kind: 'sender', senderId });

    const key = quotaKey({ kind: 'sender', senderId }, hourWindowAt(NOW));
    expect(await redis.get(key)).toBe('3');
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(3600);
    expect(ttl).toBeLessThanOrEqual(7200);
  });

  it('is exact under heavy concurrency', async () => {
    const senderId = uid();
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        consumeHourlyQuota(redis, { senderId, senderLimit: 10, now: NOW }),
      ),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });

  it('counts each UTC hour separately', async () => {
    const senderId = uid();
    await consumeHourlyQuota(redis, { senderId, senderLimit: 1, now: NOW });
    const sameHour = await consumeHourlyQuota(redis, { senderId, senderLimit: 1, now: NOW });
    const nextHour = await consumeHourlyQuota(redis, {
      senderId,
      senderLimit: 1,
      now: NOW + 60 * 60 * 1000,
    });
    expect(sameHour.allowed).toBe(false);
    expect(nextHour.allowed).toBe(true);
  });

  it('enforces the global limit across senders without charging the denied sender', async () => {
    const [a, b] = [uid(), uid()];
    const opts = { senderLimit: 10, globalLimit: 2, now: NOW };
    expect((await consumeHourlyQuota(redis, { senderId: a, ...opts })).allowed).toBe(true);
    expect((await consumeHourlyQuota(redis, { senderId: b, ...opts })).allowed).toBe(true);
    const third = await consumeHourlyQuota(redis, { senderId: b, ...opts });
    expect(third.allowed).toBe(false);
    expect(third.allowed === false && third.deniedBy).toEqual({ kind: 'global' });
    expect(await redis.get(quotaKey({ kind: 'sender', senderId: b }, hourWindowAt(NOW)))).toBe('1');
  });
});

describe('reserveDeferralSlot (ordered deferral)', () => {
  it('hands out consecutive slots in the next hour, spaced by the send interval', async () => {
    const scope = { kind: 'sender' as const, senderId: uid() };
    const first = await reserveDeferralSlot(redis, scope, 50, NOW, 2000);
    const second = await reserveDeferralSlot(redis, scope, 50, NOW, 2000);
    expect(first.window.key).toBe('2026030715');
    expect(first.runAt.toISOString()).toBe('2026-03-07T15:00:00.000Z');
    expect(second.slot).toBe(2);
    expect(second.runAt.toISOString()).toBe('2026-03-07T15:00:02.000Z');
  });

  it('rolls forward to the following hour once the next hour is full', async () => {
    const scope = { kind: 'sender' as const, senderId: uid() };
    const slots = [];
    for (let i = 0; i < 5; i++) slots.push(await reserveDeferralSlot(redis, scope, 2, NOW, 1000));
    expect(slots.map((s) => `${s.window.key}#${s.slot}`)).toEqual([
      '2026030715#1',
      '2026030715#2',
      '2026030716#1',
      '2026030716#2',
      '2026030717#1',
    ]);
    // Run times are strictly increasing, preserving deferral order.
    const times = slots.map((s) => s.runAt.getTime());
    expect([...times].sort((x, y) => x - y)).toEqual(times);
  });

  it('never gives two concurrent deferrals the same slot', async () => {
    const scope = { kind: 'sender' as const, senderId: uid() };
    const slots = await Promise.all(
      Array.from({ length: 30 }, () => reserveDeferralSlot(redis, scope, 10, NOW, 1000)),
    );
    const ids = new Set(slots.map((s) => s.runAt.getTime()));
    expect(ids.size).toBe(30);
  });
});

describe('claimLimitNotification', () => {
  it('returns true once per user, scope and hour window', async () => {
    const scope = { kind: 'sender' as const, senderId: uid() };
    const window = hourWindowAt(NOW);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimLimitNotification(redis, 'user-1', scope, window)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await claimLimitNotification(redis, 'user-2', scope, window)).toBe(true);
    expect(await claimLimitNotification(redis, 'user-1', scope, hourWindowAt(NOW + 3600_000))).toBe(
      true,
    );
  });
});
