import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson } from './canonical.mjs';
import { identityFromFd, pathMatchesIdentity, unlinkIfOwned } from './ownership.mjs';

export const ARCHIVE_MAGIC = Buffer.from('SDARCV01', 'ascii');
export const ARCHIVE_VERSION = 'sd-archive-v1';
const HEADER_FIELDS = ['algorithm', 'artifactKind', 'captureId', 'createdAt', 'keyId', 'manifestVersion', 'nonce', 'providerSnapshotId', 'providerSnapshotVersion', 'sourceDatabaseId', 'version'];

function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset);
    if (count <= 0) throw new Error('archive write made no progress');
    offset += count;
  }
}

function readExactKey(keyFd) {
  if (!Number.isInteger(keyFd) || keyFd < 0) throw new Error('key must be supplied by an already-open --key-fd');
  const key = Buffer.alloc(33);
  let length = 0;
  while (length < key.length) {
    const count = readSync(keyFd, key, length, key.length - length, null);
    if (count === 0) break;
    length += count;
  }
  if (length !== 32) {
    key.fill(0);
    throw new Error('archive key FD must contain exactly 32 bytes');
  }
  return key.subarray(0, 32);
}

function sha256Fd(fd) {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  try {
    let position = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, position);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      position += count;
    }
    return hash.digest('hex');
  } finally {
    buffer.fill(0);
  }
}

function validateHeader(header) {
  if (Object.keys(header).sort().join('\0') !== HEADER_FIELDS.join('\0') ||
      header.version !== ARCHIVE_VERSION || header.algorithm !== 'AES-256-GCM' ||
      header.manifestVersion !== 'sd-manifest-v1' || !/^[A-Za-z0-9._-]{1,128}$/.test(header.keyId) ||
      !header.captureId || !['logical-redis', 'native-rdb'].includes(header.artifactKind) || !header.sourceDatabaseId ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(header.createdAt) || !Number.isFinite(Date.parse(header.createdAt))) {
    throw new Error('archive header does not match sd-archive-v1');
  }
  const nonce = Buffer.from(header.nonce, 'base64');
  if (nonce.length !== 12 || nonce.toString('base64') !== header.nonce) throw new Error('archive nonce is invalid');
  if (header.artifactKind === 'native-rdb') {
    if (![header.providerSnapshotId, header.providerSnapshotVersion].every((value) => typeof value === 'string' && /^[A-Za-z0-9._:/+-]{1,256}$/.test(value))) {
      throw new Error('native RDB header requires bounded provider snapshot identity');
    }
  } else if (header.providerSnapshotId !== null || header.providerSnapshotVersion !== null) {
    throw new Error('logical archive cannot claim a provider snapshot');
  }
}

async function *chunksOf(plaintext) {
  if (Buffer.isBuffer(plaintext) || plaintext instanceof Uint8Array) {
    yield Buffer.from(plaintext);
    return;
  }
  for await (const chunk of plaintext) yield Buffer.from(chunk);
}

function writeAbortMarker(outputPath, captureId) {
  const markerPath = `${outputPath}.aborted.json`;
  writeFileSync(markerPath, `${canonicalJson({ version: 'sd-archive-abort-v1', captureId, publicationState: 'aborted-final-retained' })}\n`, { flag: 'wx', mode: 0o600 });
  const markerFd = openSync(markerPath, 'r');
  try { fsyncSync(markerFd); } finally { closeSync(markerFd); }
  return markerPath;
}

async function sealArchiveWithKey({ outputPath, header, plaintext, key, hooks = {} }) {
  if (!String(outputPath).endsWith('.sealed')) throw new Error('archive output must end in .sealed');
  const nonce = randomBytes(12);
  const completeHeader = { providerSnapshotId: null, providerSnapshotVersion: null, ...header, algorithm: 'AES-256-GCM', manifestVersion: 'sd-manifest-v1', nonce: nonce.toString('base64'), version: ARCHIVE_VERSION };
  validateHeader(completeHeader);
  const headerBytes = Buffer.from(canonicalJson(completeHeader), 'utf8');
  if (headerBytes.length > 64 * 1024) throw new Error('archive header is too large');
  const headerLength = Buffer.alloc(4);
  headerLength.writeUInt32BE(headerBytes.length);
  const prefix = Buffer.concat([ARCHIVE_MAGIC, headerLength, headerBytes]);
  const partialPath = `${outputPath}.partial`;
  const parent = dirname(outputPath);
  let parentExisted = true;
  try { lstatSync(parent); } catch (error) { if (error.code === 'ENOENT') parentExisted = false; else throw error; }
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!parentExisted) chmodSync(parent, 0o700);
  const parentMetadata = lstatSync(parent);
  if (!parentMetadata.isDirectory() || (parentMetadata.mode & 0o777) !== 0o700 || parentMetadata.uid !== process.geteuid()) throw new Error('archive parent must be an owned, non-symlink mode-0700 directory');
  for (const path of [outputPath, `${outputPath}.aborted.json`]) {
    try { lstatSync(path); throw new Error('sealed archive or abort marker already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let fd;
  let partialCreated = false;
  let finalCreated = false;
  let identity;
  try {
    fd = openSync(partialPath, 'wx+', 0o600);
    partialCreated = true;
    identity = identityFromFd(fd);
    writeAll(fd, prefix);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    cipher.setAAD(headerBytes);
    for await (const chunk of chunksOf(plaintext)) writeAll(fd, cipher.update(chunk));
    writeAll(fd, cipher.final());
    writeAll(fd, cipher.getAuthTag());
    fsyncSync(fd);
    linkSync(partialPath, outputPath);
    finalCreated = true;
    hooks.afterLink?.({ outputPath, partialPath });
    if (!unlinkIfOwned(partialPath, identity)) throw new Error('archive partial ownership changed during publication');
    partialCreated = false;
    hooks.afterPartialUnlink?.({ outputPath, partialPath });
    const parentFd = openSync(parent, 'r');
    try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
    hooks.afterParentFsync?.({ outputPath, partialPath });
    const checksum = sha256Fd(fd);
    hooks.afterChecksum?.({ outputPath, partialPath });
    let abortMarkerExists = false;
    try { lstatSync(`${outputPath}.aborted.json`); abortMarkerExists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!pathMatchesIdentity(outputPath, identity) || abortMarkerExists) throw new Error('sealed archive ownership changed during publication');
    closeSync(fd);
    fd = undefined;
    return { header: completeHeader, sha256: checksum, identity };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    const cleanupFailures = [];
    if (partialCreated) { try { unlinkIfOwned(partialPath, identity); } catch (cleanupError) { cleanupFailures.push(cleanupError); } }
    if (finalCreated) { try { writeAbortMarker(outputPath, completeHeader.captureId); } catch (cleanupError) { cleanupFailures.push(cleanupError); } }
    try {
      const parentFd = openSync(parent, 'r');
      try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
    } catch (cleanupError) { cleanupFailures.push(cleanupError); }
    if (cleanupFailures.length) throw new AggregateError([error, ...cleanupFailures], 'archive publication and cleanup failed');
    throw error;
  }
}

export function prepareArchiveSealer(keyFd) {
  const key = readExactKey(keyFd);
  let used = false;
  const prepared = async (options) => {
    if (used) throw new Error('prepared archive key is single-use');
    used = true;
    try { return await sealArchiveWithKey({ ...options, key }); } finally { key.fill(0); }
  };
  prepared.dispose = () => { used = true; key.fill(0); };
  return prepared;
}

export async function sealArchive({ keyFd, ...options }) {
  return prepareArchiveSealer(keyFd)(options);
}

export function openArchive({ archivePath, keyFd }) {
  const key = readExactKey(keyFd);
  try {
    const envelope = readFileSync(archivePath);
    if (envelope.length < 8 + 4 + 2 + 16 || !envelope.subarray(0, 8).equals(ARCHIVE_MAGIC)) throw new Error('archive is truncated or has invalid magic');
    const headerLength = envelope.readUInt32BE(8);
    if (headerLength > 64 * 1024) throw new Error('archive header is too large');
    const ciphertextStart = 12 + headerLength;
    if (ciphertextStart + 16 > envelope.length) throw new Error('archive is truncated');
    const headerBytes = envelope.subarray(12, ciphertextStart);
    let header;
    try { header = JSON.parse(headerBytes.toString('utf8')); } catch { throw new Error('archive header is invalid'); }
    validateHeader(header);
    if (canonicalJson(header) !== headerBytes.toString('utf8')) throw new Error('archive header is not canonical');
    const nonce = Buffer.from(header.nonce, 'base64');
    if (nonce.length !== 12) throw new Error('archive nonce is invalid');
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    decipher.setAAD(headerBytes);
    decipher.setAuthTag(envelope.subarray(-16));
    return { header, plaintext: Buffer.concat([decipher.update(envelope.subarray(ciphertextStart, -16)), decipher.final()]) };
  } finally {
    key.fill(0);
  }
}
