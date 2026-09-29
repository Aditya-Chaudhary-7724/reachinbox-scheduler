'use client';

import type { Stats } from '@/types/api';
import { bullBoardUrl } from '@/lib/api';
import { ExternalIcon, PlusIcon, QueueIcon } from './icons';
import { SlackConnectButton } from './SlackConnectButton';
import { Button } from './ui/Button';
import { Skeleton } from './ui/Skeleton';

const rows: Array<{ label: string; key: keyof Stats['byStatus']; dot: string }> = [
  { label: 'Scheduled', key: 'SCHEDULED', dot: 'bg-brand-500' },
  { label: 'Sending', key: 'SENDING', dot: 'bg-sky-500' },
  { label: 'Rate limited', key: 'RATE_LIMITED', dot: 'bg-amber-500' },
  { label: 'Sent', key: 'SENT', dot: 'bg-emerald-500' },
  { label: 'Failed', key: 'FAILED', dot: 'bg-red-500' },
];

export function Sidebar({ stats, onCompose }: { stats?: Stats; onCompose: () => void }) {
  return (
    <aside className="order-last space-y-5 lg:sticky lg:top-24 lg:order-none">
      {/* On small screens the compose button lives next to the page heading instead. */}
      <Button size="lg" className="hidden w-full lg:flex" onClick={onCompose} icon={<PlusIcon />}>
        Compose New Email
      </Button>

      <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-card">
        <h2 className="text-sm font-semibold text-gray-900">Overview</h2>
        <dl className="mt-3 space-y-2.5">
          {rows.map((r) => (
            <div key={r.key} className="flex items-center justify-between text-sm">
              <dt className="flex items-center gap-2 text-gray-600">
                <span className={`h-2 w-2 rounded-full ${r.dot}`} aria-hidden="true" />
                {r.label}
              </dt>
              <dd className="font-medium tabular-nums text-gray-900">
                {stats ? stats.byStatus[r.key].toLocaleString() : <Skeleton className="h-4 w-8" />}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <SlackConnectButton />

      <a
        href={bullBoardUrl}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm text-gray-500 transition-colors hover:bg-white hover:text-gray-800"
      >
        <QueueIcon width={16} height={16} />
        Queue monitor (Bull Board)
        <ExternalIcon width={14} height={14} className="ml-auto" />
      </a>
    </aside>
  );
}
