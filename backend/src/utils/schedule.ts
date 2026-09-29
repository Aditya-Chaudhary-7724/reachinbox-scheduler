/** scheduledAt for lead i = startTime + i * delayBetweenMs. */
export function computeScheduledTimes(start: Date, count: number, delayBetweenMs: number): Date[] {
  const base = start.getTime();
  return Array.from({ length: count }, (_, i) => new Date(base + i * delayBetweenMs));
}

/** Round-robin assignment: lead i goes to sender i mod n. */
export function assignRoundRobin<T>(items: readonly T[], index: number): T {
  if (items.length === 0) throw new Error('Cannot assign from an empty list');
  return items[index % items.length] as T;
}
