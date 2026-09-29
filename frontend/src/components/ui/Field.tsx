import type { ReactNode } from 'react';

/** Label + control + hint/error, shared by all form inputs. */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-gray-700">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} className="text-xs text-red-600">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-gray-500">{hint}</p>
      ) : null}
    </div>
  );
}

export const controlClass = (invalid: boolean) =>
  [
    'block w-full rounded-lg border bg-white px-3 text-sm text-gray-900 shadow-sm placeholder:text-gray-400',
    'focus:outline-none focus:ring-2 focus:ring-offset-0',
    invalid
      ? 'border-red-300 focus:border-red-400 focus:ring-red-100'
      : 'border-gray-200 focus:border-brand-400 focus:ring-brand-100',
  ].join(' ');
