import { describe, expect, it } from 'vitest';
import { assignRoundRobin, computeScheduledTimes } from '../src/utils/schedule';

describe('computeScheduledTimes', () => {
  it('spaces lead i at startTime + i * delayBetweenMs', () => {
    const start = new Date('2026-01-01T10:00:00.000Z');
    const times = computeScheduledTimes(start, 4, 2500);
    expect(times.map((t) => t.toISOString())).toEqual([
      '2026-01-01T10:00:00.000Z',
      '2026-01-01T10:00:02.500Z',
      '2026-01-01T10:00:05.000Z',
      '2026-01-01T10:00:07.500Z',
    ]);
  });

  it('schedules everything at startTime when delay is 0', () => {
    const start = new Date('2026-01-01T10:00:00.000Z');
    const times = computeScheduledTimes(start, 3, 0);
    expect(new Set(times.map((t) => t.getTime()))).toEqual(new Set([start.getTime()]));
  });

  it('returns an empty list for zero leads', () => {
    expect(computeScheduledTimes(new Date(), 0, 1000)).toEqual([]);
  });
});

describe('assignRoundRobin', () => {
  it('cycles through senders in order', () => {
    const senders = ['a', 'b', 'c'];
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => assignRoundRobin(senders, i))).toEqual([
      'a',
      'b',
      'c',
      'a',
      'b',
      'c',
      'a',
    ]);
  });

  it('throws for an empty sender list', () => {
    expect(() => assignRoundRobin([], 0)).toThrow();
  });
});
