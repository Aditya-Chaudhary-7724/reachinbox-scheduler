import Papa from 'papaparse';

// Pragmatic address check; the backend re-validates every lead.
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i;
const CANDIDATE_RE = /[^\s@<>(),;:"']+@[^\s@<>(),;:"']+/g;

export interface ParsedLeads {
  emails: string[];
  duplicates: number;
  invalid: number;
}

/**
 * Extracts addresses from any cell of a CSV/TXT file (header row or not, any column),
 * normalising to lowercase and de-duplicating while keeping first-seen order.
 */
export function extractLeads(text: string): ParsedLeads {
  const { data } = Papa.parse<string[]>(text.trim(), { skipEmptyLines: true });
  const seen = new Set<string>();
  const emails: string[] = [];
  let duplicates = 0;
  let invalid = 0;

  for (const row of data) {
    for (const cell of row) {
      for (const match of cell.match(CANDIDATE_RE) ?? []) {
        const email = match
          .trim()
          .replace(/^mailto:/i, '')
          .replace(/[.]+$/, '')
          .toLowerCase();
        if (!EMAIL_RE.test(email)) {
          invalid++;
          continue;
        }
        if (seen.has(email)) {
          duplicates++;
          continue;
        }
        seen.add(email);
        emails.push(email);
      }
    }
  }
  return { emails, duplicates, invalid };
}
