import { randomBytes, randomInt } from "node:crypto";

const B32 = "abcdefghijkmnpqrstuvwxyz23456789";

/** An unguessable id (lowercase letters and digits): 16 chars ≈ 80 bits. */
export function randomId(n = 16): string {
  const b = randomBytes(n);
  let s = "";
  for (let i = 0; i < n; i++) s += B32[b[i] & 31];
  return s;
}

/** Session codes: 6 characters that read aloud and type cleanly on a phone (no 0/O, 1/I/L). */
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export function sessionCode(): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}
export const isSessionCode = (s: string) => /^[2-9A-HJKMNP-Z]{6}$/.test(s);
export const isRunId = (s: string) => /^[a-z0-9-]{8,48}$/.test(s);
export const isPhotoId = (s: string) => /^[a-z0-9]{16}$/.test(s);
