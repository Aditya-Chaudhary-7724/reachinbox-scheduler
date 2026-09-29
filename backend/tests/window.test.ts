import { describe, expect, it } from 'vitest';
import {
  effectiveHourlyLimit,
  hourWindow,
  hourWindowAt,
  slotRunAt,
} from '../src/queue/rateLimiter';

describe('hour windows (UTC)', () => {
  it('maps a timestamp to its UTC hour window and YYYYMMDDHH key', () => {
    const w = hourWindowAt(Date.parse('2026-03-07T14:59:59.999Z'));
    expect(w.key).toBe('2026030714');
    expect(w.start.toISOString()).toBe('2026-03-07T14:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-03-07T15:00:00.000Z');
  });

  it('puts the exact hour boundary in the new window', () => {
    expect(hourWindowAt(Date.parse('2026-03-07T15:00:00.000Z')).key).toBe('2026030715');
  });

  it('rolls over days and years', () => {
    const last = hourWindowAt(Date.parse('2026-12-31T23:30:00Z'));
    expect(hourWindow(last.index + 1).key).toBe('2027010100');
  });
});

describe('slotRunAt', () => {
  const next = hourWindowAt(Date.parse('2026-03-07T15:00:00Z'));

  it('spaces ordered slots by the minimum send interval from the window start', () => {
    expect(slotRunAt(next, 1, 2000).toISOString()).toBe('2026-03-07T15:00:00.000Z');
    expect(slotRunAt(next, 2, 2000).toISOString()).toBe('2026-03-07T15:00:02.000Z');
    expect(slotRunAt(next, 50, 2000).toISOString()).toBe('2026-03-07T15:01:38.000Z');
  });
});

describe('effectiveHourlyLimit', () => {
  it('uses the stricter of campaign and env limits', () => {
    expect(effectiveHourlyLimit(50, 200)).toBe(50);
    expect(effectiveHourlyLimit(500, 200)).toBe(200);
  });
});
