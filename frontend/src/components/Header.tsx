'use client';

import type { User } from '@/types/api';
import { Logo } from './Logo';
import { LogoutIcon } from './icons';
import { Avatar } from './ui/Avatar';
import { Button } from './ui/Button';

export function Header({ user, onLogout }: { user: User; onLogout: () => void }) {
  return (
    <header className="sticky top-0 z-30 border-b border-gray-200/80 bg-white/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <Logo />
        <div className="flex items-center gap-3">
          <div className="hidden text-right sm:block">
            <p className="text-sm font-medium leading-5 text-gray-900">{user.name}</p>
            <p className="text-xs leading-4 text-gray-500">{user.email}</p>
          </div>
          <Avatar src={user.avatarUrl} name={user.name} />
          <div className="h-6 w-px bg-gray-200" aria-hidden="true" />
          <Button
            variant="ghost"
            size="sm"
            onClick={onLogout}
            icon={<LogoutIcon width={16} height={16} />}
          >
            <span className="hidden sm:inline">Logout</span>
          </Button>
        </div>
      </div>
    </header>
  );
}
