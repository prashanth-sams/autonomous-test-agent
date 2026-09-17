import { createHash } from 'node:crypto';

export function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}

export function shortHash(input: string, length = 10): string {
  return sha1(input).slice(0, length);
}

/** Collapse whitespace so cosmetic formatting never changes a fingerprint. */
export function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Replace the parts of a string that legitimately differ between runs
 * (ids, uuids, timestamps, ports, hex blobs) so that two occurrences of the
 * same problem collapse onto one fingerprint.
 */
export function stripVolatile(value: string): string {
  return normalizeText(value)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{uuid}')
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, '{ts}')
    .replace(/\b[0-9a-f]{16,}\b/gi, '{hex}')
    .replace(/:\d{2,5}\b/g, ':{port}')
    .replace(/\b\d+\b/g, '{n}');
}
