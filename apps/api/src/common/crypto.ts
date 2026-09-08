import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** Cryptographically secure numeric OTP of the given length. */
export function generateOtpCode(length: number): string {
  const max = 10 ** length;
  return String(randomInt(0, max)).padStart(length, "0");
}

/** HMAC-SHA256 hash of an OTP code with the gateway master key. */
export function hashOtpCode(code: string, masterKey: string): string {
  return createHmac("sha256", masterKey).update(`otp:${code}`).digest("hex");
}

/** Constant-time comparison of two hex strings. */
export function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Verify an API secret against its stored SHA-256 hash in constant time. */
export function verifyApiSecret(presentedSecret: string, storedHash: string): boolean {
  return safeEqualHex(sha256Hex(presentedSecret), storedHash);
}

export function generateApiKey(): string {
  return `gw_${randomBytes(18).toString("base64url")}`;
}

export function generateApiSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** Generate a fresh credential pair; the secret is returned exactly once. */
export function generateCredentialPair(): { apiKey: string; apiSecret: string; secretHash: string } {
  const apiKey = generateApiKey();
  const apiSecret = generateApiSecret();
  return { apiKey, apiSecret, secretHash: sha256Hex(apiSecret) };
}
