'use client';

import useSWR from 'swr';
import { apiFetch, fetcher, type ApiError } from '@/lib/api';
import type { SlackStatus } from '@/types/api';

export function useSlack() {
  const { data, error, isLoading, mutate } = useSWR<SlackStatus, ApiError>(
    '/api/slack/status',
    fetcher,
  );

  /** Fetches the authorize URL first so configuration errors surface as a toast. */
  const connect = async () => {
    const { url } = await apiFetch<{ url: string }>('/api/slack/connect?redirect=false');
    window.location.href = url;
  };

  const disconnect = async () => {
    await apiFetch<void>('/api/slack', { method: 'DELETE' });
    await mutate();
  };

  const sendTest = () => apiFetch<{ ok: true }>('/api/slack/test', { method: 'POST' });

  return { status: data, error, isLoading, connect, disconnect, sendTest, refresh: mutate };
}
