const dateTime = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
});

/** Formats an ISO timestamp in the viewer's local timezone. */
export function formatDateTime(iso: string | null): string {
  return iso ? dateTime.format(new Date(iso)) : '—';
}

/** Short relative description, e.g. "in 5 min" / "3 h ago". */
export function formatRelative(iso: string, now = Date.now()): string {
  const diffSec = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(diffSec);
  const [value, unit] =
    abs < 60
      ? [abs, 's']
      : abs < 3600
        ? [Math.round(abs / 60), 'min']
        : abs < 86400
          ? [Math.round(abs / 3600), 'h']
          : [Math.round(abs / 86400), 'd'];
  if (abs < 5) return 'now';
  return diffSec > 0 ? `in ${value} ${unit}` : `${value} ${unit} ago`;
}

/** Value for <input type="datetime-local"> in local time. */
export function toDateTimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export const pluralize = (n: number, word: string) =>
  `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
