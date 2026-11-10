/**
 * signed-links.ts
 * ---------------------------------------------------------------------------
 * Short-lived file links. A link is a token that says "this file, until this moment",
 * stamped with a signature only the server can make (HMAC-SHA-256). So:
 *   - nobody can guess a link or change the file / the time inside it;
 *   - a link stops working after a few minutes, and a fresh one is made on every page load;
 *   - the link itself is the permission, so it works in an <img> or a new tab.
 *
 * The signing key is derived from the application's secret with a purpose label, so a
 * file-link signature can never be mistaken for any other kind of signature.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface LinkClaims {
  fileId: string;
  /** When the link stops working, in seconds since 1970. */
  expiresAt: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const key = (secret: string): Buffer => createHmac('sha256', secret).update('gsg:file-links:v1').digest();
const sign = (secret: string, payload: string): Buffer => createHmac('sha256', key(secret)).update(payload).digest();
const encode = (value: Buffer | string): string => Buffer.from(value).toString('base64url');

export function signLink(secret: string, claims: LinkClaims): string {
  const payload = encode(JSON.stringify({ f: claims.fileId, e: claims.expiresAt }));
  return `${payload}.${encode(sign(secret, payload))}`;
}

/** The claims inside a valid, unexpired link - or null for anything else (never throws). */
export function verifyLink(secret: string, token: string, nowSeconds: number): LinkClaims | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;

  const expected = sign(secret, payload);
  let given: Buffer;
  try {
    given = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { f?: unknown; e?: unknown };
    if (typeof claims.f !== 'string' || !UUID.test(claims.f)) return null;
    if (typeof claims.e !== 'number' || !Number.isFinite(claims.e) || claims.e <= nowSeconds) return null;
    return { fileId: claims.f, expiresAt: claims.e };
  } catch {
    return null;
  }
}
