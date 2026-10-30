import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import retry from '../../candidate/capturism-relay/pool-retry.cjs';
class PutObjectCommand { constructor(input) { this.input = input; } }
class GetObjectCommand { constructor(input) { this.input = input; } }
class ListObjectsV2Command { constructor(input) { this.input = input; } }
class DeleteObjectCommand { constructor(input) { this.input = input; } }
const source = await readFile(new URL('../../candidate/capturism-relay/pool.js', import.meta.url), 'utf8');
export function makeRelay(storage) {
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
export function storage() {
  return { objects: new Map(), writes: 0, failWrites: 0, failLists: 0,
    async send(command) {
      const { Key, Body } = command.input;
      if (command instanceof ListObjectsV2Command) {
        if (this.failLists-- > 0) throw new Error('Injected listing failure');
        return { Contents: [...this.objects.keys()].filter(key => key.startsWith(command.input.Prefix || '')).map(Key => ({ Key })) };
      }
      if (command instanceof GetObjectCommand) return { Body: { transformToString: async () => this.objects.get(Key) } };
      if (command instanceof PutObjectCommand) {
        if (this.failWrites-- > 0) throw new Error('Injected save failure');
        await new Promise(r => setTimeout(r, 5)); this.writes++; this.objects.set(Key, Body); return {};
      }
      if (command instanceof DeleteObjectCommand) { this.objects.delete(Key); return {}; }
      throw new Error('Unexpected storage request');
    },
  };
}
export const call = (relay, handler, body, booth = 'test-booth') => new Promise(resolve => relay[handler]({ body }, { resolve }, booth));
export const identity = { retryVersion: 1, contentType: 'image/jpeg', sessionId: 'session-1', code: '000000' };
export async function payload(relay) {
  const signed = await call(relay, 'handleSignUpload', identity); assert.equal(signed.status, 200);
  return { ...identity, entryId: signed.body.entryId, portraitKey: signed.body.key };
}

