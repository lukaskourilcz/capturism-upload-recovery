import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import retry from '../../candidate/capturism-relay/pool-retry.cjs';
import publication from '../../candidate/capturism-relay/pool-publication.cjs';
import { Readable } from 'node:stream';
class PutObjectCommand { constructor(input) { this.input = input; } }
class GetObjectCommand { constructor(input) { this.input = input; } }
class ListObjectsV2Command { constructor(input) { this.input = input; } }
class DeleteObjectCommand { constructor(input) { this.input = input; } }
export const storageCommands = { PutObjectCommand, GetObjectCommand };
const source = await readFile(new URL('../../candidate/capturism-relay/pool.js', import.meta.url), 'utf8');
export function makeRelay(storage, code = source, boothId = 'test-booth') {
  const module = { exports: {} };
  const context = { module, exports: module.exports, process: { env: {} }, crypto, console: { log() {}, error() {} }, Buffer, Map, Set, Date, Promise, setTimeout, clearTimeout,
    require(name) {
      if (name === 'crypto') return crypto;
      if (name === './pool-retry.cjs') return retry;
      if (name === './pool-publication.cjs') return publication;
      if (name === '@aws-sdk/client-s3') return { PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand };
      if (name === '@aws-sdk/s3-request-presigner') return { getSignedUrl: async () => 'http://127.0.0.1/fake-signed-url' };
      if (name === './quiz') return { getRecordByCode: code => code === '000000' ? { status: 'redeemed', redeemedBy: boothId, firstName: 'Synthetic', answers: [1,2,3].map(n => ({ questionId: 'q'+n, answerId: 'a' })), consent: {} } : null };
      if (name === './backup') return {};
      throw new Error('Unexpected dependency: ' + name);
    },
  };
  vm.runInNewContext(code, context);
  module.exports.init({ client: storage, bucket: 'local', jsonResponse: (res, status, body) => res.resolve({ status, body }), readBody: (req, callback) => { void callback(JSON.stringify(req.body)); } });
  return module.exports;
}
export function storage() {
  return { objects: new Map(), writes: 0, failWrites: 0, failLists: 0, beforeGet: null, beforePut: null, afterPut: null, beforeDelete: null,
    async send(command) {
      const { Key, Body } = command.input;
      if (command instanceof ListObjectsV2Command) {
        if (this.failLists-- > 0) throw new Error('Injected listing failure');
        return { Contents: [...this.objects.keys()].filter(key => key.startsWith(command.input.Prefix || '')).map(Key => ({ Key })) };
      }
      const tag = key => this.objects.has(key) ? '"' + crypto.createHash('sha256').update(this.objects.get(key)).digest('hex') + '"' : undefined;
      if (command instanceof GetObjectCommand) {
        await this.beforeGet?.(command.input);
        if (!this.objects.has(Key)) throw Object.assign(new Error('Missing object'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
        const bytes = Buffer.from(this.objects.get(Key)), stream = Readable.from([bytes]);
        stream.transformToString = async () => bytes.toString('utf8');
        return { Body: stream, ETag: tag(Key) };
      }
      if (command instanceof PutObjectCommand) {
        if (this.failWrites-- > 0) throw new Error('Injected save failure');
        await this.beforePut?.(command.input);
        // Evaluate conditions at COMMIT time, not before the simulated I/O.
        if ((command.input.IfNoneMatch === '*' && this.objects.has(Key)) || (command.input.IfMatch && command.input.IfMatch !== tag(Key))) throw Object.assign(new Error('Conditional write failed'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
        this.writes++; this.objects.set(Key, typeof Body === 'string' ? Body : Buffer.from(Body));
        await this.afterPut?.(command.input);
        return { ETag: tag(Key) };
      }
      if (command instanceof DeleteObjectCommand) { await this.beforeDelete?.(command.input); this.objects.delete(Key); return {}; }
      throw new Error('Unexpected storage request');
    },
  };
}
export const call = (relay, handler, body, booth = 'test-booth') => new Promise(resolve => relay[handler]({ body }, { resolve }, booth));
export const photo = Buffer.alloc(16000, 7);
export const identity = { retryVersion: 2, sessionId: 'session-1', code: '000000', seed: false, photoDigest: crypto.createHash('sha256').update(photo).digest('hex') };
export const uploadId = (data = identity, booth = 'test-booth') => retry.uploadIdentity(booth, data.sessionId, data.code);
export const upload = (relay, data = identity, bytes = photo, booth = 'test-booth') => new Promise(resolve => {
  const request = Readable.from([bytes]); request.headers = { 'x-pool-upload': Buffer.from(JSON.stringify(data)).toString('base64') };
  void relay.handlePoolUpload(request, { resolve }, booth);
});
