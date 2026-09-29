'use client';

import type { ReactNode } from 'react';
import type { EmailItem, EmailTab } from '@/types/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { ExternalIcon } from './icons';
import { StatusPill } from './ui/StatusPill';
import { Table, type Column } from './ui/Table';

const recipient: Column<EmailItem> = {
  key: 'to',
  header: 'Email',
  render: (e) => (
    <div className="min-w-0">
      <p className="truncate font-medium text-gray-900">{e.toAddress}</p>
      <p className="truncate text-xs text-gray-500">from {e.senderEmail}</p>
    </div>
  ),
};

const subject: Column<EmailItem> = {
  key: 'subject',
  header: 'Subject',
  className: 'max-w-xs',
  render: (e) => (
    <p className="truncate text-gray-700" title={e.subject}>
      {e.subject}
    </p>
  ),
};

const scheduledColumns: Column<EmailItem>[] = [
  recipient,
  subject,
  {
    key: 'scheduledAt',
    header: 'Scheduled time',
    className: 'whitespace-nowrap',
    render: (e) => {
      const moved = e.scheduledAt !== e.originalScheduledAt;
      return (
        <div>
          <p className="tabular-nums text-gray-900">{formatDateTime(e.scheduledAt)}</p>
          <p className="text-xs text-gray-500">
            {moved
              ? `moved from ${formatDateTime(e.originalScheduledAt)}`
              : formatRelative(e.scheduledAt)}
          </p>
        </div>
      );
    },
  },
  {
    key: 'status',
    header: 'Status',
    render: (e) => (
      <StatusPill
        status={e.status}
        title={
          e.status === 'RATE_LIMITED'
            ? 'Hourly limit reached; deferred to the next window'
            : undefined
        }
      />
    ),
  },
];

const sentColumns: Column<EmailItem>[] = [
  recipient,
  subject,
  {
    key: 'sentAt',
    header: 'Sent time',
    className: 'whitespace-nowrap',
    render: (e) => (
      <div>
        <p className="tabular-nums text-gray-900">{formatDateTime(e.sentAt)}</p>
        {e.sentAt ? <p className="text-xs text-gray-500">{formatRelative(e.sentAt)}</p> : null}
      </div>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    render: (e) => (
      <div className="flex items-center gap-3">
        <StatusPill status={e.status} title={e.error ?? undefined} />
        {e.previewUrl ? (
          <a
            href={e.previewUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700"
          >
            Preview
            <ExternalIcon width={12} height={12} />
          </a>
        ) : null}
      </div>
    ),
  },
];

export function EmailTable({
  tab,
  rows,
  loading,
  empty,
}: {
  tab: EmailTab;
  rows: EmailItem[];
  loading: boolean;
  empty: ReactNode;
}) {
  return (
    <Table
      columns={tab === 'scheduled' ? scheduledColumns : sentColumns}
      rows={rows}
      rowKey={(e) => e.id}
      loading={loading}
      empty={empty}
    />
  );
}
