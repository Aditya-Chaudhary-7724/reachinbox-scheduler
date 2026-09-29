'use client';

import { useState } from 'react';
import { useSlack } from '@/hooks/useSlack';
import { ApiError } from '@/lib/api';
import { SlackIcon } from './icons';
import { Button } from './ui/Button';
import { Skeleton } from './ui/Skeleton';
import { useToast } from './ui/Toast';

const message = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong');

/** Slack connection card: connect, or show workspace/channel with test + disconnect. */
export function SlackConnectButton() {
  const { status, isLoading, connect, disconnect, sendTest } = useSlack();
  const toast = useToast();
  const [busy, setBusy] = useState<'connect' | 'test' | 'disconnect' | null>(null);

  const run = async (
    action: NonNullable<typeof busy>,
    fn: () => Promise<unknown>,
    done?: string,
  ) => {
    setBusy(action);
    try {
      await fn();
      if (done) toast.success(done);
    } catch (err) {
      toast.error('Slack', message(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-card">
      <div className="flex items-center gap-2.5">
        <SlackIcon />
        <h2 className="text-sm font-semibold text-gray-900">Slack alerts</h2>
        {status?.connected ? (
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
            Connected
          </span>
        ) : null}
      </div>

      {isLoading || !status ? (
        <div className="mt-4 space-y-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : status.connected ? (
        <>
          <p className="mt-3 text-sm text-gray-600">
            Posting to <span className="font-medium text-gray-900">{status.channel}</span> in{' '}
            <span className="font-medium text-gray-900">{status.teamName}</span> when a sender hits
            its hourly limit.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              loading={busy === 'test'}
              onClick={() => run('test', sendTest, `Test message sent to ${status.channel}`)}
            >
              Send test
            </Button>
            <Button
              variant="danger"
              size="sm"
              loading={busy === 'disconnect'}
              onClick={() => run('disconnect', disconnect, 'Slack disconnected')}
            >
              Disconnect
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-3 text-sm text-gray-600">
            Get notified in Slack when a sender reaches its hourly limit and emails are deferred.
          </p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-4 w-full"
            loading={busy === 'connect'}
            onClick={() => run('connect', connect)}
            icon={<SlackIcon width={16} height={16} />}
          >
            Connect Slack
          </Button>
        </>
      )}
    </section>
  );
}
