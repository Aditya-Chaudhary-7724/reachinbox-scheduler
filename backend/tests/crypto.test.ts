import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../src/utils/crypto';

const key = crypto.randomBytes(32).toString('hex');

describe('AES-256-GCM helpers', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const url = 'https://hooks.slack.com/services/T000/B000/XXXX';
    const a = encrypt(url, key);
    const b = encrypt(url, key);
    expect(a).not.toBe(b);
    expect(a).not.toContain('hooks.slack.com');
    expect(decrypt(a, key)).toBe(url);
  });

  it('rejects tampered ciphertext and wrong keys', () => {
    const payload = encrypt('secret', key);
    const [iv, tag, data] = payload.split('.');
    const flipped = Buffer.from(data ?? '', 'base64');
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() => decrypt([iv, tag, flipped.toString('base64')].join('.'), key)).toThrow();
    expect(() => decrypt(payload, crypto.randomBytes(32).toString('hex'))).toThrow();
  });
});
