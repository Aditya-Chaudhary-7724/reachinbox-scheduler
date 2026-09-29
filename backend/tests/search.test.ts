import { EmailStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/prisma';
import {
  esClient,
  indexCampaignEmails,
  recreateSearchIndex,
  searchEmails,
  syncEmailToIndex,
} from '../src/services/search';
import { createFixtures } from './helpers';

const INDEX = 'emails_test';
let fx: Awaited<ReturnType<typeof createFixtures>>;
let other: Awaited<ReturnType<typeof createFixtures>>;

const refresh = () => esClient.indices.refresh({ index: INDEX });

beforeAll(async () => {
  await recreateSearchIndex();
  fx = await createFixtures();
  other = await createFixtures();
  await fx.createEmail({ toAddress: 'alice@acme.io', subject: 'Pricing proposal' });
  await fx.createEmail({
    toAddress: 'bob@globex.com',
    subject: 'Intro call',
    body: 'Kubernetes migration',
  });
  await fx.createEmail({
    toAddress: 'carol@acme.io',
    subject: 'Follow up',
    status: EmailStatus.SENT,
  });
  await other.createEmail({ toAddress: 'alice@acme.io', subject: 'Pricing proposal' });
  await indexCampaignEmails(fx.campaign.id);
  await indexCampaignEmails(other.campaign.id);
  await refresh();
});

afterAll(async () => {
  await fx.cleanup();
  await other.cleanup();
  await prisma.$disconnect();
  await esClient.close();
});

const search = (q: string, status?: 'scheduled' | 'sent') =>
  searchEmails({ userId: fx.user.id, q, status, page: 1, limit: 20 });

describe('Elasticsearch search (real cluster)', () => {
  it('creates the index with the explicit mapping', async () => {
    const mapping = await esClient.indices.getMapping({ index: INDEX });
    const props = mapping[INDEX]?.mappings.properties ?? {};
    expect(props.status?.type).toBe('keyword');
    expect(props.userId?.type).toBe('keyword');
    expect(props.toAddress?.type).toBe('text');
    expect(props.scheduledAt?.type).toBe('date');
  });

  it('matches recipients by address, including prefixes while typing', async () => {
    expect((await search('acme')).items.map((i) => i.toAddress).sort()).toEqual([
      'alice@acme.io',
      'carol@acme.io',
    ]);
    expect((await search('ali')).items.map((i) => i.toAddress)).toEqual(['alice@acme.io']);
  });

  it('matches subject and body text', async () => {
    expect((await search('pricing')).items.map((i) => i.toAddress)).toEqual(['alice@acme.io']);
    expect((await search('kubernetes')).items.map((i) => i.toAddress)).toEqual(['bob@globex.com']);
  });

  it('only returns the requesting user’s emails', async () => {
    const result = await search('alice');
    expect(result.total).toBe(1);
    expect(result.items[0]?.campaignId).toBe(fx.campaign.id);
  });

  it('filters by status group', async () => {
    expect((await search('acme', 'sent')).items.map((i) => i.toAddress)).toEqual(['carol@acme.io']);
    expect((await search('acme', 'scheduled')).items.map((i) => i.toAddress)).toEqual([
      'alice@acme.io',
    ]);
  });

  it('reflects status changes and ignores out-of-order (older) updates', async () => {
    const bob = await prisma.email.findFirstOrThrow({ where: { toAddress: 'bob@globex.com' } });
    await prisma.email.update({ where: { id: bob.id }, data: { status: EmailStatus.SENT } });
    await syncEmailToIndex(bob.id);

    // An older document version arriving late must not overwrite the newer status.
    await esClient
      .index({
        index: INDEX,
        id: bob.id,
        version: bob.updatedAt.getTime(),
        version_type: 'external_gte',
        document: { status: EmailStatus.SCHEDULED },
      })
      .catch(() => undefined);
    await refresh();

    const doc = await esClient.get<{ status: string }>({ index: INDEX, id: bob.id });
    expect(doc._source?.status).toBe(EmailStatus.SENT);
    expect((await search('bob', 'sent')).items).toHaveLength(1);
  });
});
