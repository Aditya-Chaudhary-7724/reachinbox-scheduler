import net from 'node:net';
import type { Sender } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  SMTP_TIMEOUTS,
  closeTransporters,
  messageIdFor,
  sendMail,
  smtpTransportOptions,
  smtpTransporterFor,
} from '../src/services/mailer';

// Exercise the real SMTP path in this file only (the suite default is MOCK_SMTP=true).
// vi.mock is hoisted above the imports, so the mailer sees this env.
vi.mock('../src/config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/env')>();
  return { ...actual, env: { ...actual.env, MOCK_SMTP: false } };
});

/** Minimal SMTP server: counts TCP connections and records each message's DATA. */
function startFakeSmtp() {
  const state = { connections: 0, messages: [] as string[] };
  const server = net.createServer((socket) => {
    state.connections++;
    let buffer = '';
    let inData = false;
    let data = '';
    socket.write('220 fake.smtp ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            state.messages.push(data);
            data = '';
            socket.write('250 OK queued\r\n');
          } else data += `${line}\n`;
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') socket.write('250-fake.smtp\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (cmd === 'AUTH') socket.write('235 2.7.0 Authentication successful\r\n');
        else if (cmd === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (cmd === 'QUIT') socket.end('221 Bye\r\n');
        else socket.write('250 OK\r\n'); // MAIL, RCPT, RSET, NOOP
      }
    });
    socket.on('error', () => undefined);
  });
  return { server, state };
}

const sender = (overrides: Partial<Sender> = {}): Sender => ({
  id: 'sender-1',
  name: 'Test Sender',
  email: 'sender@example.com',
  smtpHost: '127.0.0.1',
  smtpPort: 587,
  smtpUser: 'user',
  smtpPass: 'pass',
  createdAt: new Date(),
  ...overrides,
});

const mail = (emailId: string) => ({
  emailId,
  to: 'lead@example.com',
  subject: 'Hi',
  body: 'Hello',
});

let fake: ReturnType<typeof startFakeSmtp>;
let port: number;

beforeAll(async () => {
  fake = startFakeSmtp();
  await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  port = (fake.server.address() as net.AddressInfo).port;
});

afterEach(() => closeTransporters());

afterAll(() => new Promise<void>((resolve) => fake.server.close(() => resolve())));

describe('smtpTransportOptions', () => {
  it('pools a single connection per sender with explicit timeouts', () => {
    const options = smtpTransportOptions(sender());
    expect(options).toMatchObject({
      host: '127.0.0.1',
      port: 587,
      secure: false,
      auth: { user: 'user', pass: 'pass' },
      pool: true,
      maxConnections: 1,
      maxMessages: 50,
      connectionTimeout: SMTP_TIMEOUTS.connectionTimeout,
      greetingTimeout: SMTP_TIMEOUTS.greetingTimeout,
      socketTimeout: SMTP_TIMEOUTS.socketTimeout,
    });
    // Much shorter than nodemailer's defaults (2 min connect, 10 min socket idle).
    expect(SMTP_TIMEOUTS.connectionTimeout).toBeLessThan(120_000);
    expect(SMTP_TIMEOUTS.socketTimeout).toBeLessThan(600_000);
  });

  it('uses implicit TLS only on port 465', () => {
    expect(smtpTransportOptions(sender({ smtpPort: 465 })).secure).toBe(true);
  });
});

describe('persistent transporter per sender', () => {
  it('returns the same transporter for a sender and a different one per sender', () => {
    const a1 = smtpTransporterFor(sender({ id: 'a' }));
    const a2 = smtpTransporterFor(sender({ id: 'a' }));
    const b = smtpTransporterFor(sender({ id: 'b' }));
    expect(a1).toBe(a2);
    expect(b).not.toBe(a1);
  });

  it('sends consecutive emails over one reused SMTP connection, keeping the Message-ID', async () => {
    const before = fake.state.connections;
    const s = sender({ smtpPort: port });

    const first = await sendMail(s, mail('email-1'));
    const second = await sendMail(s, mail('email-2'));

    expect(fake.state.connections - before).toBe(1);
    expect(first.messageId).toBe(messageIdFor('email-1'));
    expect(second.messageId).toBe(messageIdFor('email-2'));
    expect(fake.state.messages.at(-1)).toContain(`Message-ID: ${messageIdFor('email-2')}`);
    // Not an Ethereal server, so there is no preview URL (Ethereal behaviour is unchanged).
    expect(first.previewUrl).toBeNull();
  });

  it('discards a failed transporter so the retry reconnects with a fresh one', async () => {
    // A port with nothing listening: the send fails quickly (ECONNREFUSED).
    const closed = net.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const deadPort = (closed.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const s = sender({ id: 'flaky', smtpPort: deadPort });
    const broken = smtpTransporterFor(s);
    await expect(sendMail(s, mail('email-3'))).rejects.toThrow();

    const replacement = smtpTransporterFor(s);
    expect(replacement).not.toBe(broken);
  });
});
