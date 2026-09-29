'use client';

import Image from 'next/image';
import { useState } from 'react';
import { cn } from '@/lib/cn';

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
}

export function Avatar({
  src,
  name,
  size = 36,
}: {
  src: string | null;
  name: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size };

  if (src && !failed) {
    return (
      <Image
        src={src}
        alt={name}
        width={size}
        height={size}
        style={style}
        className="rounded-full object-cover ring-2 ring-white"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      style={style}
      className={cn(
        'inline-flex items-center justify-center rounded-full bg-brand-100 font-semibold text-brand-700 ring-2 ring-white',
        size < 32 ? 'text-xs' : 'text-sm',
      )}
      aria-label={name}
    >
      {initials(name)}
    </span>
  );
}
