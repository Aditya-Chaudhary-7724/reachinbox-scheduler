'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { ComposeForm } from '@/components/ComposeForm';
import { EmailTable } from '@/components/EmailTable';
import { FullPageSpinner } from '@/components/FullPageSpinner';
import { Header } from '@/components/Header';
import { ClockIcon, MailIcon, PlusIcon, SearchIcon, SendIcon } from '@/components/icons';
import { Pagination } from '@/components/Pagination';
import { SearchBar } from '@/components/SearchBar';
import { Sidebar } from '@/components/Sidebar';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Tabs } from '@/components/ui/Tabs';
import { useToast } from '@/components/ui/Toast';
import { useAuth } from '@/hooks/useAuth';
import { useEmails, useStats } from '@/hooks/useEmails';
import { useDebounced, useSearch } from '@/hooks/useSearch';
import { useSlack } from '@/hooks/useSlack';
import type { EmailTab, User } from '@/types/api';

const PAGE_SIZE = 20;

const SLACK_RESULTS: Record<string, { ok: boolean; title: string; description?: string }> = {
  connected: {
    ok: true,
    title: 'Slack connected',
    description: 'Rate-limit alerts will be posted to your channel.',
  },
  denied: { ok: false, title: 'Slack connection cancelled' },
  error: { ok: false, title: 'Could not connect Slack', description: 'Please try again.' },
};

/** Auth gate: data hooks below only mount once a user is confirmed. */
function Dashboard() {
  const router = useRouter();
  const { user, isLoading, error, logout } = useAuth();

  // Signed out → login page.
  useEffect(() => {
    if (user === null) router.replace('/login');
  }, [user, router]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <EmptyState
          icon={<MailIcon />}
          title="Can't reach the server"
          description={error.message}
          action={<Button onClick={() => window.location.reload()}>Retry</Button>}
        />
      </div>
    );
  }
  if (isLoading || !user) return <FullPageSpinner />;
  return <DashboardContent user={user} logout={logout} />;
}

function DashboardContent({ user, logout }: { user: User; logout: () => Promise<void> }) {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const { refresh: refreshSlack } = useSlack();

  const [tab, setTab] = useState<EmailTab>('scheduled');
  const [page, setPage] = useState(1);
  const [composeOpen, setComposeOpen] = useState(false);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounced(query);
  const searching = debouncedQuery.trim().length > 0;

  const stats = useStats();
  const list = useEmails(tab, page, PAGE_SIZE);
  const search = useSearch(debouncedQuery, tab, page, PAGE_SIZE);
  const active = searching ? search : list;

  // Result of the Slack OAuth round-trip (?slack=connected|denied|error).
  useEffect(() => {
    const result = params.get('slack');
    if (!result) return;
    const info = SLACK_RESULTS[result] ?? SLACK_RESULTS.error!;
    if (info.ok) toast.success(info.title, info.description);
    else toast.error(info.title, info.description);
    void refreshSlack();
    router.replace('/dashboard');
  }, [params, router, toast, refreshSlack]);

  useEffect(() => {
    if (active.error && active.error.status !== 401) {
      toast.error(searching ? 'Search failed' : 'Could not load emails', active.error.message);
    }
  }, [active.error, searching, toast]);

  const changeTab = (next: EmailTab) => {
    setTab(next);
    setPage(1);
  };
  const changeQuery = (value: string) => {
    setQuery(value);
    setPage(1);
  };

  const onScheduled = useCallback(() => {
    setComposeOpen(false);
    setTab('scheduled');
    setPage(1);
    setQuery('');
    void stats.mutate();
    void list.mutate();
  }, [stats, list]);

  const onLogout = async () => {
    try {
      await logout();
    } finally {
      router.replace('/login');
    }
  };

  const data = active.data;
  const loading = !data && !active.error;

  const empty = searching ? (
    <EmptyState
      icon={<SearchIcon />}
      title="No matching emails"
      description={`Nothing in ${tab === 'scheduled' ? 'scheduled' : 'sent'} emails matches “${debouncedQuery.trim()}”.`}
      action={
        <Button variant="secondary" onClick={() => changeQuery('')}>
          Clear search
        </Button>
      }
    />
  ) : tab === 'scheduled' ? (
    <EmptyState
      icon={<ClockIcon />}
      title="No scheduled emails"
      description="Compose a campaign to schedule emails. They’ll show up here until they’re sent."
      action={
        <Button onClick={() => setComposeOpen(true)} icon={<PlusIcon width={16} height={16} />}>
          Compose New Email
        </Button>
      }
    />
  ) : (
    <EmptyState
      icon={<SendIcon />}
      title="No sent emails yet"
      description="Emails appear here once they’ve been delivered, along with a preview link."
    />
  );

  return (
    <div className="min-h-screen">
      <Header user={user} onLogout={() => void onLogout()} />

      <main className="mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[17rem_minmax(0,1fr)] lg:px-8 lg:py-8">
        <Sidebar stats={stats.data} onCompose={() => setComposeOpen(true)} />

        <section className="min-w-0">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-gray-900">Emails</h1>
              <p className="mt-1 text-sm text-gray-500">
                Times are shown in your local timezone. The list refreshes automatically.
              </p>
            </div>
            <Button
              className="lg:hidden"
              onClick={() => setComposeOpen(true)}
              icon={<PlusIcon width={16} height={16} />}
              aria-label="Compose New Email"
            >
              <span className="hidden sm:inline">Compose New Email</span>
            </Button>
          </div>

          <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-card">
            <div className="flex flex-col gap-3 border-b border-gray-100 p-4 sm:flex-row sm:items-center sm:justify-between">
              <Tabs
                items={[
                  {
                    id: 'scheduled',
                    label: 'Scheduled',
                    icon: <ClockIcon width={16} height={16} />,
                    count: stats.data?.scheduled,
                  },
                  {
                    id: 'sent',
                    label: 'Sent',
                    icon: <SendIcon width={16} height={16} />,
                    count: stats.data?.sent,
                  },
                ]}
                active={tab}
                onChange={changeTab}
              />
              <SearchBar
                value={query}
                onChange={changeQuery}
                searching={searching && search.isValidating && !search.data}
              />
            </div>

            <EmailTable tab={tab} rows={data?.items ?? []} loading={loading} empty={empty} />
            {data ? (
              <Pagination
                page={data.page}
                totalPages={data.totalPages}
                total={data.total}
                limit={data.limit}
                onPage={setPage}
              />
            ) : null}
          </div>
        </section>
      </main>

      <ComposeForm
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        onScheduled={onScheduled}
      />
    </div>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <Dashboard />
    </Suspense>
  );
}
