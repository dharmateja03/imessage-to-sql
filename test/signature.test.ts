import { describe, expect, it } from "vitest";
import { buildSignature, isValidSignature } from "../src/signature";

describe("signature", () => {
  it("validates a correct HMAC signature", () => {
    const secret = "super-secret";
    const payload = '{"hello":"world"}';
    const signature = buildSignature(secret, payload);

    expect(isValidSignature(secret, payload, signature)).toBe(true);
    expect(isValidSignature(secret, payload, `sha256=${signature}`)).toBe(true);
  });

  it("rejects an invalid signature", () => {
    const secret = "super-secret";
    const payload = '{"hello":"world"}';

    expect(isValidSignature(secret, payload, "bad-signature")).toBe(false);
  });
});
