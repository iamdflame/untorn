import { describe, expect, it } from "vitest";
import { isAccountRefusal } from "./refusal";

describe("isAccountRefusal", () => {
  it("is the account, not the request: 401, 402, or a quota, credit or billing answer", () => {
    expect(isAccountRefusal(401)).toBe(true);
    expect(isAccountRefusal(402)).toBe(true);
    expect(isAccountRefusal(429, "insufficient_quota", "You exceeded your current quota")).toBe(true);
    expect(isAccountRefusal(403, null, "Billing is not active for this account")).toBe(true);
    expect(isAccountRefusal(null, "insufficient_credits", null)).toBe(true);
  });
  it("a busy, broken or bad request is not", () => {
    expect(isAccountRefusal(429, "rate_limit_exceeded", "Too many requests")).toBe(false);
    expect(isAccountRefusal(500, null, "internal error")).toBe(false);
    expect(isAccountRefusal(503)).toBe(false);
    expect(isAccountRefusal(400, "invalid_request", "image too large")).toBe(false);
    expect(isAccountRefusal(403, null, "Forbidden")).toBe(false);
    expect(isAccountRefusal(null, null, "fetch failed")).toBe(false);
  });
});
