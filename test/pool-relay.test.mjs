import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import retry from '../candidate/capturism-relay/pool-retry.cjs';

class PutObjectCommand { constructor(input) { this.input = input; } }
class GetObjectCommand { constructor(input) { this.input = input; } }
class ListObjectsV2Command { constructor(input) { this.input = input; } }
class DeleteObjectCommand { constructor(input) { this.input = input; } }
const source = await readFile(new URL('../candidate/capturism-relay/pool.js', import.meta.url), 'utf8');
function makeRelay(storage) {
  const module = { exports: {} };
  const context = { module, exports: module.exports, process: { env: {} }, crypto, console: { log() {}, error() {} }, Buffer, Map, Set, Date, Promise,
    require(name) {
      if (name === 'crypto') return crypto;
      if (name === './pool-retry.cjs') return retry;
      if (name === '@aws-sdk/client-s3') return { PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand };
      if (name === '@aws-sdk/s3-request-presigner') return { getSignedUrl: async () => 'http://127.0.0.1/fake-signed-url' };
      if (name === './quiz') return { getRecordByCode: code => code === '000000' ? { status: 'redeemed', redeemedBy: 'test-booth', firstName: 'Synthetic', answers: [], consent: {} } : null };
      if (name === './backup') return {};
      throw new Error('Unexpected dependency: ' + name);
    },
  };
  vm.runInNewContext(source, context);
  module.exports.init({ client: storage, bucket: 'local', jsonResponse: (res, status, body) => res.resolve({ status, body }), readBody: (req, callback) => { void callback(JSON.stringify(req.body)); } });
  return module.exports;
}
function storage() {
  return { objects: new Map(), writes: 0, failWrites: 0, failLists: 0,
    async send(command) {
      const { Key, Body } = command.input;
      if (command instanceof ListObjectsV2Command) {
        if (this.failLists-- > 0) throw new Error('Injected listing failure');
        return { Contents: [...this.objects.keys()].map(Key => ({ Key })) };
      }
      if (command instanceof GetObjectCommand) return { Body: { transformToString: async () => this.objects.get(Key) } };
      if (command instanceof PutObjectCommand) {
        if (this.failWrites-- > 0) throw new Error('Injected save failure');
        await new Promise(r => setTimeout(r, 5)); this.writes++; this.objects.set(Key, Body); return {};
      }
      throw new Error('Unexpected storage request');
    },
  };
}
const call = (relay, handler, body, booth = 'test-booth') => new Promise(resolve => relay[handler]({ body }, { resolve }, booth));
const identity = { retryVersion: 1, contentType: 'image/jpeg', sessionId: 'session-1', code: '000000' };
async function payload(relay) {
  const signed = await call(relay, 'handleSignUpload', identity); assert.equal(signed.status, 200);
  return { ...identity, entryId: signed.body.entryId, portraitKey: signed.body.key };
}

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
