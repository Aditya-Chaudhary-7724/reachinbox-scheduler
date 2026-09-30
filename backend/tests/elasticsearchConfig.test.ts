import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@elastic/elasticsearch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { envSchema } from '../src/config/env';
import { elasticsearchClientOptions } from '../src/services/search';

const baseEnv = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(32),
  BULL_BOARD_PASS: 'pass',
};

describe('ELASTICSEARCH_API_KEY env validation', () => {
  it('is optional and treats blank values as unset (local development)', () => {
    expect(envSchema.parse(baseEnv).ELASTICSEARCH_API_KEY).toBeUndefined();
    expect(
      envSchema.parse({ ...baseEnv, ELASTICSEARCH_API_KEY: '' }).ELASTICSEARCH_API_KEY,
    ).toBeUndefined();
    expect(
      envSchema.parse({ ...baseEnv, ELASTICSEARCH_API_KEY: '   ' }).ELASTICSEARCH_API_KEY,
    ).toBeUndefined();
  });

  it('keeps a provided key (trimmed)', () => {
    expect(
      envSchema.parse({ ...baseEnv, ELASTICSEARCH_API_KEY: '  encoded-key==  ' })
        .ELASTICSEARCH_API_KEY,
    ).toBe('encoded-key==');
  });
});

describe('elasticsearchClientOptions', () => {
  it('uses no auth when no API key is configured', () => {
    const options = elasticsearchClientOptions({
      ELASTICSEARCH_URL: 'http://localhost:9200',
      ELASTICSEARCH_API_KEY: undefined,
    });
    expect(options).toEqual({ node: 'http://localhost:9200' });
  });

  it('uses API-key auth when a key is configured', () => {
    const options = elasticsearchClientOptions({
      ELASTICSEARCH_URL: 'https://example.es.cloud:443',
      ELASTICSEARCH_API_KEY: 'encoded-key==',
    });
    expect(options).toEqual({
      node: 'https://example.es.cloud:443',
      auth: { apiKey: 'encoded-key==' },
    });
  });
});

describe('Authorization header actually sent by the client', () => {
  const seen: Array<string | undefined> = [];
  let server: http.Server;
  let url: string;

  beforeAll(async () => {
    // Minimal stand-in for Elasticsearch: records the Authorization header of each request.
    server = http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-elastic-product': 'Elasticsearch',
      });
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('sends "ApiKey <key>" only when a key is configured', async () => {
    const withKey = new Client(
      elasticsearchClientOptions({
        ELASTICSEARCH_URL: url,
        ELASTICSEARCH_API_KEY: 'encoded-key==',
      }),
    );
    const withoutKey = new Client(
      elasticsearchClientOptions({ ELASTICSEARCH_URL: url, ELASTICSEARCH_API_KEY: undefined }),
    );

    await withKey.ping();
    await withoutKey.ping();
    await Promise.all([withKey.close(), withoutKey.close()]);

    expect(seen).toEqual(['ApiKey encoded-key==', undefined]);
  });
});
