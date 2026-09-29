'use client';

import useSWR from 'swr';
import { ApiError, apiFetch, fetcher } from '@/lib/api';
import type { User } from '@/types/api';

/** Current user from /auth/me. `user === null` means definitely signed out. */
export function useAuth() {
  const { data, error, isLoading, mutate } = useSWR<User, ApiError>('/auth/me', fetcher, {
    shouldRetryOnError: (err: ApiError) => err.status !== 401,
    revalidateOnFocus: false,
  });

  const signedOut = error?.status === 401;

  const logout = async () => {
    await apiFetch<void>('/auth/logout', { method: 'POST' });
    await mutate(undefined, { revalidate: false });
  };

  return {
    user: signedOut ? null : data,
    isLoading: isLoading && !signedOut,
    // Non-401 failures (e.g. API down) should be shown, not treated as logged out.
    error: signedOut ? undefined : error,
    logout,
  };
}
