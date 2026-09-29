import type { TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { Field, controlClass } from './Field';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  id: string;
  label: string;
  hint?: string;
  error?: string;
}

export function Textarea({ id, label, hint, error, className, ...props }: TextareaProps) {
  return (
    <Field label={label} htmlFor={id} hint={hint} error={error}>
      <textarea
        id={id}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        className={cn(
          controlClass(Boolean(error)),
          'min-h-32 resize-y py-2.5 leading-6',
          className,
        )}
        {...props}
      />
    </Field>
  );
}
