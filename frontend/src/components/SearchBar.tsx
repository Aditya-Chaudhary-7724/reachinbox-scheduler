'use client';

import { SearchIcon, XIcon } from './icons';
import { Spinner } from './ui/Spinner';

export function SearchBar({
  value,
  onChange,
  searching,
}: {
  value: string;
  onChange: (value: string) => void;
  searching?: boolean;
}) {
  return (
    <div className="relative w-full sm:max-w-xs">
      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-gray-400">
        {searching ? <Spinner /> : <SearchIcon width={16} height={16} />}
      </span>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search recipient, subject or body…"
        aria-label="Search emails"
        className="h-10 w-full rounded-lg border border-gray-200 bg-white pl-9 pr-9 text-sm text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100 [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange('')}
          className="absolute inset-y-0 right-2 flex items-center rounded p-1 text-gray-400 hover:text-gray-600"
          aria-label="Clear search"
        >
          <XIcon width={16} height={16} />
        </button>
      ) : null}
    </div>
  );
}
