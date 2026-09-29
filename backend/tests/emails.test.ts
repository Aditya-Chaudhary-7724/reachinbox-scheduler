import { describe, expect, it } from 'vitest';
import { normalizeLeads } from '../src/utils/emails';

describe('normalizeLeads', () => {
  it('trims, lowercases, dedupes and separates invalid entries', () => {
    const result = normalizeLeads([
      ' Alice@Example.com ',
      'alice@example.com',
      'bob@example.com',
      'not-an-email',
      '',
      'carol@example',
    ]);
    expect(result.valid).toEqual(['alice@example.com', 'bob@example.com']);
    expect(result.invalid).toEqual(['not-an-email', 'carol@example']);
    expect(result.duplicates).toBe(1);
  });
});
