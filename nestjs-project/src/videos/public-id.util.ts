import { randomBytes } from 'node:crypto';

const ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const PUBLIC_ID_LENGTH = 11;
export const PUBLIC_ID_PATTERN = /^[0-9A-Za-z]{11}$/;

// 248 = 4 * 62: the largest multiple of the alphabet size that fits in a byte.
// Bytes at or above it are discarded so `byte % 62` stays uniform (no modulo bias).
const REJECTION_THRESHOLD = 248;

/** Short, URL-safe, collision-resistant public id (phase-03-videos/TD-10). */
export function generatePublicId(): string {
  let id = '';
  while (id.length < PUBLIC_ID_LENGTH) {
    for (const byte of randomBytes(PUBLIC_ID_LENGTH * 2)) {
      if (byte >= REJECTION_THRESHOLD) continue;
      id += ALPHABET[byte % ALPHABET.length];
      if (id.length === PUBLIC_ID_LENGTH) break;
    }
  }
  return id;
}
