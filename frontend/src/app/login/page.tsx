'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { FullPageSpinner } from '@/components/FullPageSpinner';
import { ClockIcon, GoogleIcon, SendIcon, SlackIcon } from '@/components/icons';
import { Logo } from '@/components/Logo';
import { useAuth } from '@/hooks/useAuth';
import { googleLoginUrl } from '@/lib/api';

const ERRORS: Record<string, string> = {
  access_denied: 'Google sign-in was cancelled.',
  invalid_state: 'Your sign-in session expired. Please try again.',
  oauth_failed: 'We could not sign you in with Google. Please try again.',
  missing_code: 'Google did not complete the sign-in. Please try again.',
};

const highlights = [
  { icon: <ClockIcon />, text: 'Schedule thousands of emails with per-sender hourly limits' },
  { icon: <SendIcon />, text: 'Reliable delivery that survives restarts, sent exactly once' },
  { icon: <SlackIcon />, text: 'Slack alerts the moment a sender hits its limit' },
];

function LoginContent() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const errorCode = useSearchParams().get('error');

  useEffect(() => {
    if (user) router.replace('/dashboard');
  }, [user, router]);

  if (isLoading || user) return <FullPageSpinner />;

  return (
    <main className="grid min-h-screen lg:grid-cols-2">
      <section className="flex flex-col justify-between px-6 py-8 sm:px-12">
        <Logo />
        <div className="mx-auto w-full max-w-sm py-12">
          <h1 className="text-3xl font-semibold tracking-tight text-gray-900">Welcome back</h1>
          <p className="mt-2 text-sm text-gray-500">
            Sign in to schedule campaigns and track every email you send.
          </p>

          {errorCode ? (
            <div
              role="alert"
              className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
            >
              {ERRORS[errorCode] ?? 'Sign-in failed. Please try again.'}
            </div>
          ) : null}

          <a
            href={googleLoginUrl}
            className="mt-8 flex h-12 w-full items-center justify-center gap-3 rounded-lg border border-gray-300 bg-white text-sm font-medium text-gray-800 shadow-sm transition-colors hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
          >
            <GoogleIcon />
            Continue with Google
          </a>
          <p className="mt-4 text-center text-xs text-gray-400">
            We only use your name, email and profile picture.
          </p>
        </div>
        <p className="text-xs text-gray-400">© {new Date().getFullYear()} ReachInbox</p>
      </section>

      <section className="relative hidden overflow-hidden bg-gradient-to-br from-brand-600 via-brand-700 to-brand-900 lg:flex lg:items-center lg:justify-center">
        <div
          className="absolute -right-24 -top-24 h-96 w-96 rounded-full bg-white/10 blur-3xl"
          aria-hidden="true"
        />
        <div
          className="absolute -bottom-32 -left-16 h-96 w-96 rounded-full bg-brand-400/20 blur-3xl"
          aria-hidden="true"
        />
        <div className="relative max-w-md px-12 text-white">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">
            Outreach that lands, on schedule.
          </h2>
          <ul className="mt-8 space-y-5">
            {highlights.map((h) => (
              <li key={h.text} className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/15 ring-1 ring-inset ring-white/20">
                  {h.icon}
                </span>
                <span className="pt-1.5 text-sm text-brand-50">{h.text}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <LoginContent />
    </Suspense>
  );
}
