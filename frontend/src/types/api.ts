/** Shapes returned by the backend API (see backend/src/routes). */

export type EmailStatus = 'SCHEDULED' | 'SENDING' | 'SENT' | 'FAILED' | 'RATE_LIMITED';
export type EmailTab = 'scheduled' | 'sent';

export interface User {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}

export interface EmailItem {
  id: string;
  campaignId: string;
  toAddress: string;
  subject: string;
  status: EmailStatus;
  senderEmail: string;
  scheduledAt: string;
  originalScheduledAt: string;
  sentAt: string | null;
  previewUrl: string | null;
  error: string | null;
  attempts: number;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface Stats {
  byStatus: Record<EmailStatus, number>;
  scheduled: number;
  sent: number;
}

export type SlackStatus =
  | { connected: true; teamName: string; channel: string }
  | { connected: false; teamName: null; channel: null };

export interface Sender {
  id: string;
  name: string;
  email: string;
}

export interface CreateCampaignRequest {
  subject: string;
  body: string;
  leads: string[];
  startTime: string;
  delayBetweenMs: number;
  hourlyLimit: number;
  /** Omit to spread the campaign round-robin across all senders. */
  senderId?: string;
}

export interface CreateCampaignResponse {
  campaign: { id: string; totalEmails: number; startTime: string };
  scheduled: number;
  invalid: string[];
  duplicatesRemoved: number;
  firstScheduledAt: string | null;
  lastScheduledAt: string | null;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}
