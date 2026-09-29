import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

/** AES-256-GCM. Output format: base64(iv).base64(authTag).base64(ciphertext). */
export function encrypt(plaintext: string, keyHex: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(keyHex, 'hex'), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

/** Throws if the payload was tampered with or the key is wrong (GCM authentication). */
export function decrypt(payload: string, keyHex: string): string {
  const [iv, tag, data] = payload.split('.').map((p) => Buffer.from(p, 'base64'));
  if (!iv || !tag || !data) throw new Error('Malformed encrypted payload');
  const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(keyHex, 'hex'), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
