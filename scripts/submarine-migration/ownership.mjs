import { fstatSync, lstatSync, unlinkSync } from 'node:fs';

export function identityFromFd(fd) {
  const metadata = fstatSync(fd);
  return Object.freeze({ dev: metadata.dev, ino: metadata.ino });
}

export function pathMatchesIdentity(path, identity) {
  if (!identity) return false;
  try {
    const metadata = lstatSync(path);
    return metadata.dev === identity.dev && metadata.ino === identity.ino;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export function unlinkIfOwned(path, identity) {
  if (!pathMatchesIdentity(path, identity)) return false;
  unlinkSync(path);
  return true;
}
