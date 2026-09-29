import type { ApiErrorBody } from '@/types/api';

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(
  /\/+$/,
  '',
);

/** Every failed request surfaces as an ApiError with a user-presentable message. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string = 'ERROR',
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as ApiErrorBody).error?.message === 'string'
  );
}

/** Turns zod's flattened field errors into one readable line. */
function describeValidation(details: unknown): string | null {
  if (typeof details !== 'object' || details === null || !('fieldErrors' in details)) return null;
  const fieldErrors = (details as { fieldErrors: Record<string, string[] | undefined> })
    .fieldErrors;
  const parts = Object.entries(fieldErrors)
    .filter(([, msgs]) => msgs && msgs.length > 0)
    .map(([field, msgs]) => `${field}: ${msgs?.[0]}`);
  return parts.length > 0 ? parts.join('; ') : null;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Is the backend running?', 'NETWORK_ERROR');
  }

  if (response.status === 204) return undefined as T;

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (isApiErrorBody(body)) {
      const { code, message, details } = body.error;
      const detail = code === 'VALIDATION_ERROR' ? describeValidation(details) : null;
      throw new ApiError(response.status, detail ?? message, code, details);
    }
    throw new ApiError(response.status, `Request failed (${response.status})`);
  }
  return body as T;
}

/** SWR fetcher. */
export const fetcher = <T>(path: string) => apiFetch<T>(path);

export const googleLoginUrl = `${API_URL}/auth/google`;
export const bullBoardUrl = `${API_URL}/admin/queues`;
