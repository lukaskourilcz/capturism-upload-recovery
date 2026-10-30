import fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import queue from './candidate/pool-queue.cjs';
class PutObjectCommand { constructor(input) { this.input = input; } }
class GetObjectCommand { constructor(input) { this.input = input; } }
class DeleteObjectCommand { constructor(input) { this.input = input; } }
export const poolCommands = { PutObjectCommand, GetObjectCommand, DeleteObjectCommand };
export function localPoolStorage(directory, { beforePut = async () => {}, onPut = () => {} } = {}) {
  fs.mkdirSync(directory, { recursive: true });
  const objects = new Map();
  const tag = key => objects.has(key) ? '"' + createHash('sha256').update(objects.get(key)).digest('hex') + '"' : undefined;
  const file = key => join(directory, createHash('sha256').update(key).digest('hex') + '.json');
  return { objects, async send(command) {
    const { Key, Body } = command.input;
    if (command instanceof GetObjectCommand) {
      if (!objects.has(Key)) throw Object.assign(new Error('Missing object'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
      return { Body: Readable.from([Buffer.from(objects.get(Key))]), ETag: tag(Key) };
    }
    if (command instanceof PutObjectCommand) {
      await beforePut(command.input);
      if ((command.input.IfNoneMatch === '*' && objects.has(Key)) || (command.input.IfMatch && tag(Key) !== command.input.IfMatch)) throw Object.assign(new Error('Conditional write failed'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
      const bytes = Buffer.from(Body);
      queue.atomicJSON(file(Key), { key: Key, bytes: bytes.toString('base64') });
      objects.set(Key, bytes); onPut(Key, bytes); return { ETag: tag(Key) };
    }
    if (command instanceof DeleteObjectCommand) { try { fs.unlinkSync(file(Key)); } catch (err) { if (err.code !== 'ENOENT') throw err; } objects.delete(Key); return {}; }
    throw new Error('Unexpected local storage operation');
  } };
}
