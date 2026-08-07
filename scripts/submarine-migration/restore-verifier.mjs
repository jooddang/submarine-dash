import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { captureManifest } from './capture.mjs';
import { compareManifestSnapshots } from './manifest.mjs';

function encodeCommand(parts) {
  return Buffer.concat([Buffer.from(`*${parts.length}\r\n`), ...parts.flatMap((part) => {
    const bytes = Buffer.from(part);
    return [Buffer.from(`$${bytes.length}\r\n`), bytes, Buffer.from('\r\n')];
  })]);
}

function parseResponse(bytes, offset = 0) {
  const lineEnd = bytes.indexOf('\r\n', offset);
  if (lineEnd < 0) return null;
  const prefix = bytes[offset];
  const line = bytes.subarray(offset + 1, lineEnd);
  if (prefix === 43) return { value: line, offset: lineEnd + 2 };
  if (prefix === 45) throw new Error(`disposable Redis error: ${line.toString()}`);
  if (prefix === 58) return { value: Number(line), offset: lineEnd + 2 };
  if (prefix === 36) {
    const length = Number(line);
    if (length === -1) return { value: null, offset: lineEnd + 2 };
    const start = lineEnd + 2;
    if (bytes.length < start + length + 2) return null;
    return { value: bytes.subarray(start, start + length), offset: start + length + 2 };
  }
  if (prefix === 42) {
    const length = Number(line);
    const values = [];
    let cursor = lineEnd + 2;
    for (let index = 0; index < length; index += 1) {
      const parsed = parseResponse(bytes, cursor);
      if (!parsed) return null;
      values.push(parsed.value);
      cursor = parsed.offset;
    }
    return { value: values, offset: cursor };
  }
  throw new Error('disposable Redis returned unsupported RESP');
}

export function redisCommand(socketPath, parts) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const chunks = [];
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback(value);
    };
    socket.setTimeout(2000, () => finish(reject, new Error('disposable Redis command timed out')));
    socket.on('connect', () => socket.write(encodeCommand(parts)));
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      try {
        const parsed = parseResponse(Buffer.concat(chunks));
        if (parsed) finish(resolve, parsed.value);
      } catch (error) { finish(reject, error); }
    });
    socket.on('error', (error) => finish(reject, error));
    socket.on('end', () => finish(reject, new Error('disposable Redis closed before a complete response')));
    socket.on('close', () => finish(reject, new Error('disposable Redis socket closed unexpectedly')));
  });
}

function childExited(child) {
  return child.exitCode != null || child.signalCode != null;
}

async function waitForSocket(socketPath, child, lifecycle) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (lifecycle.spawnFailed) throw new Error('disposable Redis could not start');
    if (childExited(child)) throw new Error('disposable Redis exited before socket readiness');
    try { if (lstatSync(socketPath).isSocket()) return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(20);
  }
  throw new Error('disposable Redis socket did not become ready');
}

export async function stopOwnedProcess(child, { timeoutMs = 2000, delayImpl = delay } = {}) {
  if (childExited(child)) return;
  const exit = new Promise((resolve) => child.once('exit', () => resolve(true)));
  child.kill('SIGTERM');
  const exited = await Promise.race([exit, delayImpl(timeoutMs).then(() => false)]);
  if (!exited && !childExited(child)) {
    child.kill('SIGKILL');
    const reaped = await Promise.race([exit, delayImpl(timeoutMs).then(() => false)]);
    if (!reaped && !childExited(child)) throw new Error('disposable Redis could not be reaped');
  }
}

export function assertUnprivileged(euid = process.geteuid()) {
  if (euid === 0) throw new Error('disposable restore refuses root');
}

export async function cleanupOwnedRestore(child, root, stop = stopOwnedProcess) {
  await stop(child);
  rmSync(root, { recursive: true, force: true });
}

function raw(encoded) { return Buffer.from(encoded, 'base64'); }

async function restoreRecord(socketPath, record) {
  const key = raw(record.key);
  let command;
  if (record.type === 'string') command = ['SET', key, raw(record.value.data)];
  if (record.type === 'list') command = ['RPUSH', key, ...record.value.items.map(raw)];
  if (record.type === 'set') command = ['SADD', key, ...record.value.members.map(raw)];
  if (record.type === 'hash') command = ['HSET', key, ...record.value.pairs.flatMap(({ field, value }) => [raw(field), raw(value)])];
  if (record.type === 'zset') command = ['ZADD', key, ...record.value.pairs.flatMap(({ score, member }) => [raw(score), raw(member)])];
  if (!command) throw new Error(`unsupported restore type: ${record.type}`);
  await redisCommand(socketPath, command);
  if (record.ttlClassification === 'ephemeral' && record.pttl >= 0) {
    const remaining = Date.parse(record.capturedAt) + record.pttl - Date.now();
    if (remaining <= 0) {
      await redisCommand(socketPath, ['DEL', key]);
      return false;
    }
    await redisCommand(socketPath, ['PEXPIRE', key, String(Math.ceil(remaining))]);
  }
  return true;
}

function localClient(socketPath) {
  return { execute: (command) => redisCommand(socketPath, command) };
}

export async function verifyLogicalRestore({ manifest, redisServerPath }) {
  assertUnprivileged();
  if (!redisServerPath) throw new Error('fixture restore requires an explicit redis-server path');
  const root = mkdtempSync('/tmp/submarine-restore-');
  chmodSync(root, 0o700);
  const data = join(root, 'data'); mkdirSync(data, { mode: 0o700 });
  const socketPath = join(root, 'redis.sock');
  const config = join(root, 'redis.conf');
  writeFileSync(config, `port 0\nunixsocket ${socketPath}\nunixsocketperm 700\nprotected-mode yes\ndir ${data}\nsave ""\nappendonly no\ndaemonize no\n`, { mode: 0o600 });
  let child;
  try {
    child = spawn(redisServerPath, [config], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } });
    const lifecycle = { spawnFailed: false };
    child.once('error', () => { lifecycle.spawnFailed = true; });
    await waitForSocket(socketPath, child, lifecycle);
    const info = Buffer.from(await redisCommand(socketPath, ['INFO', 'server'])).toString();
    if (!info.includes(`process_id:${child.pid}\r\n`)) throw new Error('private Redis socket is not served by the owned child PID');
    for (const record of manifest.records) await restoreRecord(socketPath, record);
    const restored = await captureManifest({
      client: localClient(socketPath), capturedAt: manifest.capturedAt,
      sourceDatabaseId: manifest.sourceDatabaseId, captureId: manifest.captureId,
      applicationCommit: manifest.applicationCommit,
    });
    const comparison = compareManifestSnapshots(manifest, restored, { commonSnapshotAt: new Date().toISOString(), ttlToleranceMs: 250, ephemeralValuePolicy: 'exact-live' });
    if (!comparison.equal) throw new Error('logical restore manifest diverged');
    return { manifestChecksum: manifest.manifestChecksum, processVerified: true, comparison };
  } finally {
    if (child) await cleanupOwnedRestore(child, root);
    else rmSync(root, { recursive: true, force: true });
  }
}
