import { normalizeText } from './hash';

/** Mask identifier-ish path segments so /orders/1042 and /orders/77 are one route. */
export function maskRoute(rawUrl: string): string {
  let pathname = rawUrl;
  try {
    pathname = new URL(rawUrl).pathname;
  } catch {
    /* already a path */
  }
  const masked = pathname
    .split('/')
    .map((segment) => {
      if (!segment) return segment;
      if (/^\d+$/.test(segment)) return ':id';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(segment)) return ':uuid';
      if (/^[0-9a-f]{16,}$/i.test(segment)) return ':hash';
      return segment;
    })
    .join('/');
  return masked === '' ? '/' : masked;
}

export function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).host;
  } catch {
    return '';
  }
}

export function describeUrl(rawUrl: string): string {
  return normalizeText(rawUrl).slice(0, 300);
}
