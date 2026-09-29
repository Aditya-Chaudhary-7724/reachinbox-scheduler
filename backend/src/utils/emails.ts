import { z } from 'zod';

const emailSchema = z.string().email().max(254);

export interface NormalizedLeads {
  valid: string[];
  invalid: string[];
  duplicates: number;
}

/** Trims, lowercases, validates and de-duplicates addresses, preserving first-seen order. */
export function normalizeLeads(raw: readonly string[]): NormalizedLeads {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  let duplicates = 0;

  for (const entry of raw) {
    const email = entry.trim().toLowerCase();
    if (!email) continue;
    if (!emailSchema.safeParse(email).success) {
      invalid.push(entry.trim());
      continue;
    }
    if (seen.has(email)) {
      duplicates++;
      continue;
    }
    seen.add(email);
    valid.push(email);
  }
  return { valid, invalid, duplicates };
}
