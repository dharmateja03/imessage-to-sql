import { createHmac, timingSafeEqual } from "node:crypto";

function normalizeSignature(signature: string): string {
  return signature.startsWith("sha256=") ? signature.slice("sha256=".length) : signature;
}

export function buildSignature(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

export function isValidSignature(secret: string, payload: string, providedSignature: string): boolean {
  const expected = buildSignature(secret, payload);
  const actual = normalizeSignature(providedSignature);

  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(actual, "utf8");

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, actualBuffer);
}
