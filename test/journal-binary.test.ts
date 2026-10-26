import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { digest, jsonBytes } from '../src/professional/bytes';
import { NativeStorage } from '../src/professional/nativeStorage';
import { storageRequest } from '../src/professional/bridge';
import { evidence, JournalEntry, publish, Storage } from '../src/professional/storage';
import { ProtocolError } from '../src/professional/types';

test('publication journals snapshot binary intent without boxing bytes or retaining caller mutations', async () => {
  const bytes = new Uint8Array(65536).fill(173), expected = bytes.slice();
  let captured: JournalEntry | undefined;
  const store: Storage = {
    identity: 'binary-test', writable: true,
    read: async () => { throw new ProtocolError('missing', 'not published'); }, list: async () => [],
    write: async () => { throw new Error('must not write after journal interruption'); }, journalGet: async () => undefined,
    journalPut: async (_, entry) => { captured = entry; throw new Error('interrupted after intent'); },
  };
  await assert.rejects(publish(store, 'binary-intent', evidence('blobs/sha256/aa/' + 'a'.repeat(64), bytes, 'application/octet-stream'), bytes), /interrupted after intent/);
  assert.ok(captured?.bytes instanceof Uint8Array); assert.notEqual(captured.bytes, bytes);
  bytes.fill(0); assert.deepEqual(captured.bytes, expected);
});

test('binary native journals retain base64 disk format and explicit legacy VS Code array DTOs', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'omr-binary-journal-')), root = path.join(temporary, 'review'), journal = path.join(temporary, 'journal');
  await mkdir(root); const store = new NativeStorage(root, journal), bytes = new Uint8Array(65536).fill(173);
  const entry: JournalEntry = { path: 'pending', bytes, acknowledged: false, digest: digest(bytes) };
  await store.journalPut('binary', entry);
  const actual = await store.journalGet('binary'); assert.ok(actual?.bytes instanceof Uint8Array); assert.deepEqual(actual.bytes, bytes);
  const filename = `${digest(`${store.identity}\0binary`).slice(7)}.json`;
  const disk = JSON.parse(await readFile(path.join(journal, filename), 'utf8'));
  assert.equal(disk.base64, Buffer.from(bytes).toString('base64')); assert.equal(disk.bytes, undefined);
  const wire = await storageRequest(store, 'journalGet', ['binary']) as JournalEntry;
  assert.ok(Array.isArray(wire.bytes)); assert.deepEqual(new Uint8Array(JSON.parse(JSON.stringify(wire)).bytes), bytes);
  await storageRequest(store, 'journalPut', ['legacy-wire', { ...entry, bytes: Array.from(bytes) }]);
  assert.deepEqual(new Uint8Array((await store.journalGet('legacy-wire'))!.bytes), bytes);
  const oldFile = `${digest(`${store.identity}\0legacy-disk`).slice(7)}.json`;
  await writeFile(path.join(journal, oldFile), jsonBytes({ ...entry, bytes: Array.from(bytes) }));
  assert.deepEqual(new Uint8Array((await store.journalGet('legacy-disk'))!.bytes), bytes);
});
