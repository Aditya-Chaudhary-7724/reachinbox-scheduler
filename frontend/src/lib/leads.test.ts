import { describe, expect, it } from 'vitest';
import { extractLeads } from './leads';

describe('extractLeads', () => {
  it('finds emails in any column, dedupes case-insensitively and skips headers', () => {
    const csv = [
      'name,email,company',
      'Alice,Alice@Example.com,Acme',
      'Bob,bob@example.com,"Globex, Inc"',
      'Alice again,alice@example.com,Acme',
      'No email,,Initech',
    ].join('\n');
    expect(extractLeads(csv)).toEqual({
      emails: ['alice@example.com', 'bob@example.com'],
      duplicates: 1,
      invalid: 0,
    });
  });

  it('handles plain text lists with mixed separators and mailto links', () => {
    const txt = 'carol@example.org; dave@example.net\nmailto:erin@example.io\n\nfrank@example.com.';
    expect(extractLeads(txt).emails).toEqual([
      'carol@example.org',
      'dave@example.net',
      'erin@example.io',
      'frank@example.com',
    ]);
  });

  it('counts malformed addresses as invalid', () => {
    const result = extractLeads('good@example.com\nbad@localhost\n');
    expect(result.emails).toEqual(['good@example.com']);
    expect(result.invalid).toBe(1);
  });

  it('returns nothing for empty input', () => {
    expect(extractLeads('')).toEqual({ emails: [], duplicates: 0, invalid: 0 });
  });
});
