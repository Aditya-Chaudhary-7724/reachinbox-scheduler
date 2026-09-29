import type { InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { Field, controlClass } from './Field';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  id: string;
  label: string;
  hint?: string;
  error?: string;
}

export function Input({ id, label, hint, error, className, ...props }: InputProps) {
  return (
    <Field label={label} htmlFor={id} hint={hint} error={error}>
      <input
        id={id}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        className={cn(controlClass(Boolean(error)), 'h-10', className)}
        {...props}
      />
    </Field>
  );
}
