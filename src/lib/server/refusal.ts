// A refused key: Meta's model API turning the account away (no credit left, the key revoked) rather than the request.
// No retry helps, so callers stop at once and live runs pause (live-status.ts). No imports: bench scripts load it too.

/** True when an API error is about the account, not the request: 401, 402, or a quota, credit or billing refusal. */
export function isAccountRefusal(status: number | null | undefined, code?: string | null, message?: string | null): boolean {
  if (status === 401 || status === 402) return true;
  const s = `${code ?? ""} ${message ?? ""}`.toLowerCase();
  return /insufficient[_ ]?(quota|credit|credits|funds|balance)|quota[_ ]?exceeded|exceeded your (current )?quota|billing|payment[_ ]?required|out of credits?|credits? (exhausted|expired|used up)|no (remaining )?credits?/.test(s);
}
