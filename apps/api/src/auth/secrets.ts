import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Secret handling for the auth-engine.
 *
 * Two different problems, two different tools:
 *   * bearer tokens are long random values, so a fast SHA-256 lookup hash is enough and
 *     a slow KDF would only add latency to every request;
 *   * the dispatcher password is human-chosen, so it needs a deliberately slow KDF.
 *
 * Nothing here ever returns a stored secret. A token value is shown once, at creation,
 * and a login code is only ever compared (context/41 section 4.3).
 */

/** Opaque bearer token: 256 bits, URL-safe. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Lookup hash for a high-entropy token. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Six-digit login code.
 *
 * `randomInt` is the CSPRNG, not `Math.random`: the code is the only thing standing
 * between an address and a session.
 */
export function generateLoginCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * Hash of a login code, bound to the address it was issued for, so a code observed for
 * one address cannot be replayed against another.
 */
export function hashLoginCode(email: string, code: string): string {
  return createHash('sha256').update(`${email.toLowerCase()}:${code}`, 'utf8').digest('hex');
}

const SCRYPT_KEY_LENGTH = 64;

/** Derives a verifier for a human-chosen password. */
export function derivePasswordHash(password: string, salt: string): Buffer {
  return scryptSync(password, salt, SCRYPT_KEY_LENGTH);
}

/** Constant-time comparison; a length difference must not leak through early exit. */
export function secretsMatch(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function newSalt(): string {
  return randomBytes(16).toString('hex');
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
