'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { ApiError, apiFetch } from '@/lib/api';
import { formatDateTime, pluralize, toDateTimeLocalValue } from '@/lib/format';
import { extractLeads, type ParsedLeads } from '@/lib/leads';
import type { CreateCampaignRequest, CreateCampaignResponse } from '@/types/api';
import { SendIcon } from './icons';
import { Button } from './ui/Button';
import { DateTimePicker } from './ui/DateTimePicker';
import { Field } from './ui/Field';
import { FileUpload } from './ui/FileUpload';
import { Input } from './ui/Input';
import { Modal } from './ui/Modal';
import { Textarea } from './ui/Textarea';
import { useToast } from './ui/Toast';

const MAX_LEADS = 10_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const PREVIEW_COUNT = 5;

interface FormState {
  subject: string;
  body: string;
  startTime: string;
  delaySeconds: string;
  hourlyLimit: string;
}

type Errors = Partial<Record<keyof FormState | 'leads', string>>;

const initialState = (): FormState => ({
  subject: '',
  body: '',
  startTime: toDateTimeLocalValue(new Date(Date.now() + 5 * 60 * 1000)),
  delaySeconds: '2',
  hourlyLimit: '50',
});

function validate(form: FormState, leads: ParsedLeads | null): Errors {
  const errors: Errors = {};
  if (!form.subject.trim()) errors.subject = 'Subject is required';
  else if (form.subject.length > 998) errors.subject = 'Subject is too long';
  if (!form.body.trim()) errors.body = 'Body is required';

  if (!leads) errors.leads = 'Upload a CSV or TXT file with recipient emails';
  else if (leads.emails.length === 0) errors.leads = 'No valid email addresses found in this file';
  else if (leads.emails.length > MAX_LEADS)
    errors.leads = `At most ${MAX_LEADS.toLocaleString()} recipients per campaign`;

  const start = new Date(form.startTime);
  if (!form.startTime || Number.isNaN(start.getTime())) errors.startTime = 'Pick a start time';
  else if (start.getTime() < Date.now() - 60_000) errors.startTime = 'Start time is in the past';

  const delay = Number(form.delaySeconds);
  if (form.delaySeconds === '' || !Number.isFinite(delay) || delay < 0 || delay > 86_400) {
    errors.delaySeconds = 'Enter 0–86,400 seconds';
  }

  const limit = Number(form.hourlyLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) {
    errors.hourlyLimit = 'Enter a whole number from 1 to 100,000';
  }
  return errors;
}

export function ComposeForm({
  open,
  onClose,
  onScheduled,
}: {
  open: boolean;
  onClose: () => void;
  onScheduled: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState<FormState>(initialState);
  const [leads, setLeads] = useState<ParsedLeads | null>(null);
  const [fileName, setFileName] = useState<string>();
  const [errors, setErrors] = useState<Errors>({});
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    const next = { ...form, [key]: value };
    setForm(next);
    if (submitted) setErrors(validate(next, leads));
  };

  const reset = () => {
    setForm(initialState());
    setLeads(null);
    setFileName(undefined);
    setErrors({});
    setSubmitted(false);
  };

  const close = () => {
    if (submitting) return;
    reset();
    onClose();
  };

  const onFile = async (file: File) => {
    if (file.size > MAX_FILE_BYTES) {
      setErrors((e) => ({ ...e, leads: 'File is larger than 5 MB' }));
      return;
    }
    const parsed = extractLeads(await file.text());
    setLeads(parsed);
    setFileName(file.name);
    setErrors(submitted ? validate(form, parsed) : { ...errors, leads: undefined });
  };

  // Rough finish time ignoring rate limits, to help pick the delay.
  const lastSendAt = useMemo(() => {
    const start = new Date(form.startTime).getTime();
    const delay = Number(form.delaySeconds);
    if (!leads?.emails.length || Number.isNaN(start) || !Number.isFinite(delay)) return null;
    return new Date(
      Math.max(start, Date.now()) + (leads.emails.length - 1) * delay * 1000,
    ).toISOString();
  }, [form.startTime, form.delaySeconds, leads]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    const found = validate(form, leads);
    setErrors(found);
    if (Object.keys(found).length > 0 || !leads) return;

    const payload: CreateCampaignRequest = {
      subject: form.subject.trim(),
      body: form.body,
      leads: leads.emails,
      startTime: new Date(form.startTime).toISOString(),
      delayBetweenMs: Math.round(Number(form.delaySeconds) * 1000),
      hourlyLimit: Number(form.hourlyLimit),
    };

    setSubmitting(true);
    try {
      const res = await apiFetch<CreateCampaignResponse>('/api/campaigns', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const skipped = res.invalid.length + res.duplicatesRemoved;
      toast.success(
        `Scheduled ${pluralize(res.scheduled, 'email')}`,
        `Starting ${formatDateTime(res.firstScheduledAt)}${skipped ? ` · ${skipped} skipped` : ''}`,
      );
      reset();
      onScheduled();
    } catch (err) {
      toast.error('Could not schedule emails', err instanceof ApiError ? err.message : undefined);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Compose New Email"
      description="Emails are sent one by one from your senders, respecting the hourly limit."
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="compose-form"
            loading={submitting}
            icon={<SendIcon width={16} height={16} />}
          >
            Schedule
          </Button>
        </>
      }
    >
      <form id="compose-form" onSubmit={onSubmit} noValidate className="space-y-5">
        <Input
          id="subject"
          label="Subject"
          placeholder="Quick question about {company}"
          value={form.subject}
          onChange={(e) => set('subject', e.target.value)}
          error={errors.subject}
          maxLength={998}
        />
        <Textarea
          id="body"
          label="Body"
          placeholder="Hi there, …"
          value={form.body}
          onChange={(e) => set('body', e.target.value)}
          error={errors.body}
          rows={6}
        />

        <Field label="Recipients" htmlFor="leads-file" error={errors.leads}>
          <FileUpload
            id="leads-file"
            accept=".csv,.txt,text/csv,text/plain"
            fileName={fileName}
            onFile={(f) => void onFile(f)}
            onClear={() => {
              setLeads(null);
              setFileName(undefined);
            }}
            error={errors.leads}
          />
          {leads && leads.emails.length > 0 ? (
            <div className="rounded-lg border border-brand-100 bg-brand-50/50 p-3">
              <p className="text-sm font-medium text-brand-800">
                {pluralize(leads.emails.length, 'email')} detected
                {leads.duplicates + leads.invalid > 0 ? (
                  <span className="font-normal text-brand-700/80">
                    {' '}
                    · {leads.duplicates} duplicate{leads.duplicates === 1 ? '' : 's'} removed
                    {leads.invalid ? ` · ${leads.invalid} invalid skipped` : ''}
                  </span>
                ) : null}
              </p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {leads.emails.slice(0, PREVIEW_COUNT).map((email) => (
                  <li
                    key={email}
                    className="rounded-md bg-white px-2 py-0.5 text-xs text-gray-700 ring-1 ring-inset ring-gray-200"
                  >
                    {email}
                  </li>
                ))}
                {leads.emails.length > PREVIEW_COUNT ? (
                  <li className="px-1 py-0.5 text-xs text-gray-500">
                    +{(leads.emails.length - PREVIEW_COUNT).toLocaleString()} more
                  </li>
                ) : null}
              </ul>
            </div>
          ) : null}
        </Field>

        <div className="grid gap-5 sm:grid-cols-3">
          <DateTimePicker
            id="startTime"
            label="Start time"
            value={form.startTime}
            onChange={(e) => set('startTime', e.target.value)}
            error={errors.startTime}
          />
          <Input
            id="delay"
            type="number"
            label="Delay between emails"
            hint="Seconds"
            min={0}
            step="any"
            value={form.delaySeconds}
            onChange={(e) => set('delaySeconds', e.target.value)}
            error={errors.delaySeconds}
          />
          <Input
            id="hourlyLimit"
            type="number"
            label="Hourly limit"
            hint="Per sender"
            min={1}
            step={1}
            value={form.hourlyLimit}
            onChange={(e) => set('hourlyLimit', e.target.value)}
            error={errors.hourlyLimit}
          />
        </div>

        {lastSendAt && leads && leads.emails.length > 1 ? (
          <p className="text-xs text-gray-500">
            Without rate limiting, the last email would go out around{' '}
            <span className="font-medium text-gray-700">{formatDateTime(lastSendAt)}</span>. Emails
            over the hourly limit are automatically moved to the next hour.
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
