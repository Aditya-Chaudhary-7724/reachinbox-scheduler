import { cn } from '@/lib/cn';

export function Logo({
  className,
  withWordmark = true,
}: {
  className?: string;
  withWordmark?: boolean;
}) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 shadow-sm">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M4 7.5 12 13l8-5.5"
            stroke="white"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M4 7h16v10H4z" stroke="white" strokeWidth="2" strokeLinejoin="round" />
        </svg>
      </span>
      {withWordmark ? (
        <span className="text-[17px] font-semibold tracking-tight text-gray-900">
          Reach<span className="text-brand-600">Inbox</span>
        </span>
      ) : null}
    </span>
  );
}
