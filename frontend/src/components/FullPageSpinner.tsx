import { Logo } from './Logo';
import { Spinner } from './ui/Spinner';

export function FullPageSpinner() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4">
      <Logo />
      <Spinner className="h-5 w-5 text-brand-600" />
    </div>
  );
}
