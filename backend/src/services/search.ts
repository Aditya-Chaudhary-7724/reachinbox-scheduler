import { Client, errors, type ClientOptions } from '@elastic/elasticsearch';
import type { Email } from '@prisma/client';
import { env, type Env } from '../config/env';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';
import { SCHEDULED_STATUSES, SENT_STATUSES, toEmailDto, type EmailListKind } from './email';

/** API-key auth when a key is configured (e.g. Elastic Cloud); no auth for local dev. */
export function elasticsearchClientOptions(
  config: Pick<Env, 'ELASTICSEARCH_URL' | 'ELASTICSEARCH_API_KEY'>,
): ClientOptions {
  return {
    node: config.ELASTICSEARCH_URL,
    ...(config.ELASTICSEARCH_API_KEY ? { auth: { apiKey: config.ELASTICSEARCH_API_KEY } } : {}),
  };
}

export const esClient = new Client(elasticsearchClientOptions(env));
const INDEX = env.ELASTICSEARCH_INDEX;

type IndexableEmail = Email & { sender: { email: string } };

const MAPPINGS = {
  dynamic: 'strict' as const,
  properties: {
    toAddress: { type: 'text' as const, fields: { keyword: { type: 'keyword' as const } } },
    subject: { type: 'text' as const },
    body: { type: 'text' as const },
    status: { type: 'keyword' as const },
    userId: { type: 'keyword' as const },
    campaignId: { type: 'keyword' as const },
    senderEmail: { type: 'keyword' as const },
    scheduledAt: { type: 'date' as const },
    sentAt: { type: 'date' as const },
    createdAt: { type: 'date' as const },
  },
};

export async function ensureSearchIndex(): Promise<void> {
  if (await esClient.indices.exists({ index: INDEX })) return;
  try {
    await esClient.indices.create({ index: INDEX, mappings: MAPPINGS });
    logger.info({ index: INDEX }, 'Created Elasticsearch index');
  } catch (err) {
    // API and worker may race to create it at boot.
    if (
      err instanceof errors.ResponseError &&
      err.body?.error?.type === 'resource_already_exists_exception'
    ) {
      return;
    }
    throw err;
  }
}

export async function recreateSearchIndex(): Promise<void> {
  await esClient.indices.delete({ index: INDEX, ignore_unavailable: true });
  await ensureSearchIndex();
}

function toDocument(email: IndexableEmail) {
  return {
    toAddress: email.toAddress,
    subject: email.subject,
    body: email.body,
    status: email.status,
    userId: email.userId,
    campaignId: email.campaignId,
    senderEmail: email.sender.email,
    scheduledAt: email.scheduledAt.toISOString(),
    sentAt: email.sentAt?.toISOString() ?? null,
    createdAt: email.createdAt.toISOString(),
  };
}

/**
 * Documents use external versioning with version = updatedAt (ms). If two status changes
 * are indexed out of order, Elasticsearch rejects the older one, so the index converges
 * on the latest DB state.
 */
const versionOf = (email: Email) => email.updatedAt.getTime();

export async function indexEmails(emails: IndexableEmail[]): Promise<void> {
  if (emails.length === 0) return;
  const operations = emails.flatMap((email) => [
    {
      index: {
        _index: INDEX,
        _id: email.id,
        version: versionOf(email),
        version_type: 'external_gte' as const,
      },
    },
    toDocument(email),
  ]);
  const result = await esClient.bulk({ operations });
  if (result.errors) {
    const failures = result.items.filter((i) => i.index?.error && i.index.status !== 409);
    if (failures.length > 0) {
      logger.warn(
        { failures: failures.length, sample: failures[0]?.index?.error },
        'Bulk index had failures',
      );
    }
  }
}

/**
 * Re-reads the email from Postgres and indexes it. Never throws: search is a secondary
 * view, and indexing problems must not affect sending (`npm run reindex` repairs drift).
 */
export async function syncEmailToIndex(emailId: string): Promise<void> {
  try {
    const email = await prisma.email.findUnique({
      where: { id: emailId },
      include: { sender: { select: { email: true } } },
    });
    if (!email) return;
    await esClient.index({
      index: INDEX,
      id: email.id,
      version: versionOf(email),
      version_type: 'external_gte',
      document: toDocument(email),
    });
  } catch (err) {
    if (err instanceof errors.ResponseError && err.statusCode === 409) return; // newer version already indexed
    logger.warn({ err, emailId }, 'Failed to index email');
  }
}

/** Indexes freshly created campaign emails in bulk; failures are logged, not thrown. */
export async function indexCampaignEmails(campaignId: string): Promise<void> {
  try {
    const emails = await prisma.email.findMany({
      where: { campaignId },
      include: { sender: { select: { email: true } } },
    });
    for (let i = 0; i < emails.length; i += 500) {
      await indexEmails(emails.slice(i, i + 500));
    }
  } catch (err) {
    logger.warn({ err, campaignId }, 'Failed to index campaign emails');
  }
}

export interface SearchParams {
  userId: string;
  q: string;
  status?: EmailListKind;
  page: number;
  limit: number;
}

/**
 * Full-text search in Elasticsearch (scoped to the user), then hydrated from Postgres so
 * statuses shown are always current even if the index lags slightly.
 */
export async function searchEmails({ userId, q, status, page, limit }: SearchParams) {
  const filter: object[] = [{ term: { userId } }];
  if (status) {
    filter.push({ terms: { status: status === 'scheduled' ? SCHEDULED_STATUSES : SENT_STATUSES } });
  }

  const result = await esClient.search<{ toAddress: string }>({
    index: INDEX,
    from: (page - 1) * limit,
    size: limit,
    track_total_hits: true,
    query: {
      bool: {
        filter,
        must: [
          {
            // bool_prefix treats the last term as a prefix, so results appear while typing.
            multi_match: {
              query: q,
              type: 'bool_prefix',
              fields: ['toAddress^3', 'subject^2', 'body'],
            },
          },
        ],
      },
    },
    sort: ['_score', { scheduledAt: 'desc' }],
  });

  const ids = result.hits.hits.map((h) => h._id).filter((id): id is string => Boolean(id));
  const rows = await prisma.email.findMany({
    where: { id: { in: ids }, userId },
    include: { sender: { select: { email: true } } },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const total =
    typeof result.hits.total === 'number' ? result.hits.total : (result.hits.total?.value ?? 0);

  return {
    items: ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [toEmailDto(row)] : [];
    }),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}
