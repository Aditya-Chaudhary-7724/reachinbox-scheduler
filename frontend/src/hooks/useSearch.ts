'use client';

import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { fetcher, type ApiError } from '@/lib/api';
import type { EmailItem, EmailTab, Paginated } from '@/types/api';

export function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

/** Elasticsearch-backed search within the active tab. Disabled for an empty query. */
export function useSearch(query: string, tab: EmailTab, page: number, limit = 20) {
  const q = query.trim();
  const key = q
    ? `/api/emails/search?q=${encodeURIComponent(q)}&status=${tab}&page=${page}&limit=${limit}`
    : null;
  return useSWR<Paginated<EmailItem>, ApiError>(key, fetcher, {
    refreshInterval: 5000,
    keepPreviousData: true,
  });
}
