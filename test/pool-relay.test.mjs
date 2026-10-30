import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRelay, storage, call, identity, payload } from './helpers/relay-fixture.mjs';

test('actual relay handlers: stable signing, concurrent join and repeat confirmation create one record', async () => {
  const store = storage(), relay = makeRelay(store), body = await payload(relay), again = await payload(relay);
  assert.equal(body.entryId, again.entryId);
  const results = await Promise.all([call(relay, 'handlePoolJoin', body), call(relay, 'handlePoolJoin', body)]);
  for (const result of results) assert.equal(result.status, 200);
  assert.equal((await call(relay, 'handlePoolJoin', body)).status, 200);
  assert.equal(store.objects.size, 1); assert.equal(store.writes, 1);
  assert.equal((await call(relay, 'handlePoolJoin', { ...body, portraitKey: 'pool-portraits/other.jpg' })).status, 409);
  assert.equal((await call(relay, 'handlePoolJoin', body, 'other-booth')).status, 400);
  assert.equal((await call(relay, 'handlePoolJoin', { ...body, code: '999999' })).status, 400);
  assert.equal((await call(relay, 'handleSignUpload', { ...identity, contentType: 'image/png' })).status, 400);
  assert.equal((await call(relay, 'handlePoolJoin', { ...body, seed: true })).status, 409);
});

test('actual relay handlers: failed durable save returns 503 and can be retried', async () => {
  const store = storage(), relay = makeRelay(store), body = await payload(relay); store.failWrites = 1;
  assert.equal((await call(relay, 'handlePoolJoin', body)).status, 503);
  assert.equal(store.objects.size, 0);
  assert.equal((await call(relay, 'handlePoolJoin', body)).status, 200);
  assert.equal(store.objects.size, 1); assert.equal(store.writes, 1);
});

test('actual relay handlers: replay after restart preserves existing distribution and consent metadata', async () => {
  const store = storage(), first = makeRelay(store), body = await payload(first);
  await call(first, 'handlePoolJoin', body);
  const key = `pool/${body.entryId}.json`, saved = JSON.parse(store.objects.get(key));
  saved.distributionCount = 3; saved.status = 'retired'; store.objects.set(key, JSON.stringify(saved));
  const restarted = makeRelay(store);
  assert.equal((await call(restarted, 'handlePoolJoin', body)).status, 200);
  assert.equal(store.writes, 1); assert.equal(JSON.parse(store.objects.get(key)).distributionCount, 3);
});

test('actual relay handlers: storage hydration failures fail closed, then recover on a request', async () => {
  const store = storage(); store.failLists = 2; const relay = makeRelay(store);
  await new Promise(r => setTimeout(r, 0));
  assert.equal((await call(relay, 'handleSignUpload', identity)).status, 503);
  assert.equal((await call(relay, 'handleSignUpload', identity)).status, 200);
});

test('actual relay handlers: malformed JSON values fail as validation errors', async () => {
  const relay = makeRelay(storage());
  for (const handler of ['handleSignUpload', 'handlePoolJoin']) {
    assert.equal((await call(relay, handler, null)).status, 400);
    assert.equal((await call(relay, handler, [])).status, 400);
  }
});
