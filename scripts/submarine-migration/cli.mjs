#!/usr/bin/env node
import { chmodSync, closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareArchiveSealer } from './archive.mjs';
import { canonicalJson } from './canonical.mjs';
import { captureManifest } from './capture.mjs';
import { redactedManifest } from './manifest.mjs';
import { identityFromFd, pathMatchesIdentity, unlinkIfOwned } from './ownership.mjs';
import { ReadOnlyUpstashClient } from './upstash-readonly.mjs';

function readTokenFd(fd) {
  if (!Number.isInteger(fd) || fd < 0) throw new Error('--readonly-token-fd must name an already-open descriptor');
  const buffer = Buffer.alloc(4097);
  let length = 0;
  while (length < buffer.length) {
    const count = readSync(fd, buffer, length, buffer.length - length, null);
    if (!count) break;
    length += count;
  }
  const token = buffer.subarray(0, length).toString('utf8').trimEnd();
  buffer.fill(0);
  if (length > 4096 || token.length < 8 || token.includes('\n')) throw new Error('read-only token FD is malformed');
  return token;
}

export function parseArguments(argv, environment = process.env) {
  if (argv.some((argument) => argument === '--key' || argument.startsWith('--key=')) ||
      Object.keys(environment).some((name) => /^(SD_ARCHIVE_KEY|SUBMARINE_ARCHIVE_KEY)$/.test(name))) {
    throw new Error('archive key material is forbidden in argv and environment');
  }
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) throw new Error('invalid capture arguments');
    const key = name.slice(2);
    if (Object.hasOwn(options, key)) throw new Error('duplicate capture argument');
    options[key] = value;
  }
  const required = ['endpoint', 'readonly-token-fd', 'key-fd', 'key-id', 'capture-id', 'source-database-id', 'application-commit', 'created-at', 'output'];
  if (Object.keys(options).some((name) => !required.includes(name)) || required.some((name) => !options[name])) throw new Error('capture arguments are incomplete');
  if (!options.output.endsWith('.sealed')) throw new Error('--output must end in .sealed');
  return options;
}

function absent(path) {
  try { lstatSync(path); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

function fsyncParent(path) {
  const parentFd = openSync(dirname(path), 'r');
  try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
}

function preflightOutputPair(archivePath, evidencePath) {
  const parent = dirname(archivePath);
  if (dirname(evidencePath) !== parent) throw new Error('archive and evidence must share one staging directory');
  let existed = true;
  try { lstatSync(parent); } catch (error) { if (error.code === 'ENOENT') existed = false; else throw error; }
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!existed) chmodSync(parent, 0o700);
  const metadata = lstatSync(parent);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.geteuid() || (metadata.mode & 0o777) !== 0o700) throw new Error('capture staging directory is unsafe');
  for (const path of [archivePath, `${archivePath}.partial`, `${archivePath}.aborted.json`, `${archivePath}.pair-aborted.json`, evidencePath, `${evidencePath}.partial`]) if (!absent(path)) throw new Error('capture output already exists');
}

function publishPairAbort(path, captureId) {
  const marker = `${path}.pair-aborted.json`;
  const fd = openSync(marker, 'wx', 0o600);
  try {
    writeFileSync(fd, `${canonicalJson({ version: 'sd-pair-abort-v1', captureId, publicationState: 'aborted-finals-retained' })}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  fsyncParent(marker);
}

function publishEvidence(path, payload, { afterLink = () => {} } = {}) {
  const partial = `${path}.partial`;
  let fd;
  let partialCreated = false;
  let finalCreated = false;
  let identity;
  try {
    fd = openSync(partial, 'wx', 0o600); partialCreated = true;
    identity = identityFromFd(fd);
    writeFileSync(fd, payload);
    fsyncSync(fd);
    linkSync(partial, path);
    finalCreated = true;
    afterLink();
    if (!unlinkIfOwned(partial, identity)) throw new Error('evidence partial ownership changed during publication');
    partialCreated = false;
    fsyncParent(path);
    if (!pathMatchesIdentity(path, identity)) throw new Error('evidence ownership changed during publication');
    closeSync(fd); fd = undefined;
    return identity;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    const cleanupFailures = [];
    if (partialCreated) { try { unlinkIfOwned(partial, identity); } catch (cleanup) { cleanupFailures.push(cleanup); } }
    try { fsyncParent(path); } catch (cleanup) { cleanupFailures.push(cleanup); }
    if (cleanupFailures.length) throw new AggregateError([error, ...cleanupFailures], 'evidence publication and cleanup failed');
    throw error;
  }
}

export async function runCapture(options, { fetchImpl = globalThis.fetch, client: injectedClient, evidenceHooks, captureHooks = {} } = {}) {
  const redactedPath = `${options.output}.manifest.json`;
  preflightOutputPair(options.output, redactedPath);
  const readOnlyToken = readTokenFd(Number(options['readonly-token-fd']));
  const preparedSealer = prepareArchiveSealer(Number(options['key-fd']));
  try {
    const client = injectedClient || new ReadOnlyUpstashClient({ endpoint: options.endpoint, readOnlyToken, fetchImpl });
    const manifest = await captureManifest({
      client, capturedAt: options['created-at'], sourceDatabaseId: options['source-database-id'], captureId: options['capture-id'],
      applicationCommit: options['application-commit'],
    });
    const sealed = await preparedSealer({
      outputPath: options.output, plaintext: Buffer.from(canonicalJson(manifest)),
      header: {
        keyId: options['key-id'], captureId: options['capture-id'], artifactKind: 'logical-redis',
        sourceDatabaseId: options['source-database-id'], createdAt: options['created-at'],
      },
    });
    const redacted = redactedManifest(manifest, sealed.sha256);
    let evidenceIdentity;
    try {
      captureHooks.afterArchive?.({ archivePath: options.output, evidencePath: redactedPath });
      evidenceIdentity = publishEvidence(redactedPath, `${canonicalJson(redacted)}\n`, evidenceHooks);
      captureHooks.afterEvidence?.({ archivePath: options.output, evidencePath: redactedPath });
      if (!pathMatchesIdentity(options.output, sealed.identity) || !pathMatchesIdentity(redactedPath, evidenceIdentity) ||
          !absent(`${options.output}.aborted.json`) || !absent(`${options.output}.pair-aborted.json`)) throw new Error('archive pair ownership changed during publication');
    } catch (error) {
      const cleanupFailures = [];
      try { publishPairAbort(options.output, options['capture-id']); } catch (cleanup) { cleanupFailures.push(cleanup); }
      try { fsyncParent(options.output); } catch (cleanup) { cleanupFailures.push(cleanup); }
      if (cleanupFailures.length) throw new AggregateError([error, ...cleanupFailures], 'archive pair cleanup failed');
      throw error;
    }
    return redacted;
  } finally {
    preparedSealer.dispose();
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const redacted = await runCapture(options);
  process.stdout.write(`${canonicalJson(redacted)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    process.stderr.write('submarine preservation failed; see redacted operator diagnostics\n');
    process.exitCode = 1;
  });
}
