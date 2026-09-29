import type { EmailStatus } from '@/types/api';
import { cn } from '@/lib/cn';

const styles: Record<EmailStatus, { label: string; className: string; dot: string }> = {
  SCHEDULED: {
    label: 'Scheduled',
    className: 'bg-brand-50 text-brand-700 ring-brand-200',
    dot: 'bg-brand-500',
  },
  SENDING: {
    label: 'Sending',
    className: 'bg-sky-50 text-sky-700 ring-sky-200',
    dot: 'bg-sky-500 animate-pulse',
  },
  RATE_LIMITED: {
    label: 'Rate limited',
    className: 'bg-amber-50 text-amber-700 ring-amber-200',
    dot: 'bg-amber-500',
  },
  SENT: {
    label: 'Sent',
    className: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    dot: 'bg-emerald-500',
  },
  FAILED: { label: 'Failed', className: 'bg-red-50 text-red-700 ring-red-200', dot: 'bg-red-500' },
};

export function StatusPill({ status, title }: { status: EmailStatus; title?: string }) {
  const s = styles[status];
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset',
        s.className,
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', s.dot)} aria-hidden="true" />
      {s.label}
    </span>
  );
}
