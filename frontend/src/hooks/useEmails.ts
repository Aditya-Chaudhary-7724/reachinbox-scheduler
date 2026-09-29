'use client';

import useSWR from 'swr';
import { fetcher, type ApiError } from '@/lib/api';
import type { EmailItem, EmailTab, Paginated, Stats } from '@/types/api';

// UI refresh only: scheduling itself happens in BullMQ, not in the browser.
const REFRESH_MS = 5000;

export function useEmails(tab: EmailTab, page: number, limit = 20) {
  return useSWR<Paginated<EmailItem>, ApiError>(
    `/api/emails?status=${tab}&page=${page}&limit=${limit}`,
    fetcher,
    { refreshInterval: REFRESH_MS, keepPreviousData: true },
  );
}

export function useStats() {
  return useSWR<Stats, ApiError>('/api/stats', fetcher, { refreshInterval: REFRESH_MS });
}
