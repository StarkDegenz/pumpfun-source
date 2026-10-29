import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { buildApp, type Fixture } from '../src/app.js';

const fixture = (path: string, body: unknown): Fixture => ({
  method: 'GET', path, status: 200, body, source: 'synthetic:decoded-capture',
  headers: { 'Content-Encoding': 'gzip', 'Content-Type': 'application/json', 'x-captured': 'retained' },
});

test('decoded JSON fixture values remain readable over real HTTP with captured compression headers', async () => {
  const values = [{ label: 'decoded é' }, 'decoded string', null];
  const app = buildApp(values.map((value, index) => fixture(`/decoded-${index}`, value)));
  try {
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    for (const [index, value] of values.entries()) {
      const response = await fetch(`${origin}/decoded-${index}`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), value);
      assert.equal(response.headers.get('content-encoding'), null);
      assert.equal(response.headers.get('x-captured'), 'retained');
    }
  } finally { await app.close(); }
});

test('raw compressed Buffer fixtures keep their encoding and original bytes', async () => {
  const value = { label: 'raw compressed é' };
  const bytes = gzipSync(JSON.stringify(value));
  const app = buildApp([fixture('/compressed', bytes)]);
  try {
    const injected = await app.inject('/compressed');
    assert.deepEqual(injected.rawPayload, bytes);
    assert.equal(injected.headers['content-encoding'], 'gzip');
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${origin}/compressed`);
    assert.equal(response.headers.get('content-encoding'), 'gzip');
    assert.deepEqual(await response.json(), value);
  } finally { await app.close(); }
});

test('HEAD and bodyless status fixtures retain representation metadata', async () => {
  const fixtures = [
    { ...fixture('/head', null), method: 'HEAD' },
    ...[204, 205, 304].map(status => ({ ...fixture(`/empty-${status}`, null), status })),
  ];
  const app = buildApp(fixtures);
  try {
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    for (const entry of fixtures) {
      const response = await fetch(origin + entry.path, { method: entry.method });
      assert.equal(response.status, entry.status);
      assert.equal(response.headers.get('content-encoding'), 'gzip');
      assert.equal(await response.text(), '');
    }
  } finally { await app.close(); }
});
