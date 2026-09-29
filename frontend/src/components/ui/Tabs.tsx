import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface TabItem<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode;
  count?: number;
}

export function Tabs<T extends string>({
  items,
  active,
  onChange,
}: {
  items: TabItem<T>[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div role="tablist" className="flex gap-1 rounded-xl bg-gray-100 p-1">
      {items.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={selected}
            onClick={() => onChange(tab.id)}
            className={cn(
              'flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors',
              selected ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800',
            )}
          >
            {tab.icon}
            {tab.label}
            {tab.count !== undefined ? (
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-xs tabular-nums',
                  selected ? 'bg-brand-50 text-brand-700' : 'bg-gray-200/70 text-gray-600',
                )}
              >
                {tab.count.toLocaleString()}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
