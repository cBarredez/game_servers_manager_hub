import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // 12h

interface ProofPayload {
  username: string;
  issuedAt: number;
}

/**
 * Stateless, signed session token: base64url(payload) + "." + HMAC-SHA256(payload).
 * Same scheme as arma_server/proyect_zomboid so the panel doesn't need a
 * server-side session store.
 */
export function createSessionProof(username: string, secret: string, now = Date.now()): string {
  const payload: ProofPayload = { username, issuedAt: now };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
  const signature = sign(payloadB64, secret);
  return `${payloadB64}.${signature}`;
}

export function verifySessionProof(
  token: string | undefined,
  secret: string,
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
): { valid: true; username: string } | { valid: false } {
  if (!token) return { valid: false };

  const [payloadB64, signature] = token.split(".");
  if (!payloadB64 || !signature) return { valid: false };

  const expectedSignature = sign(payloadB64, secret);
  if (!safeEqual(signature, expectedSignature)) return { valid: false };

  let payload: ProofPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf-8"));
  } catch {
    return { valid: false };
  }

  if (typeof payload.username !== "string" || typeof payload.issuedAt !== "number") {
    return { valid: false };
  }
  if (now - payload.issuedAt > ttlMs || payload.issuedAt > now + 60_000) {
    return { valid: false };
  }

  return { valid: true, username: payload.username };
}

function sign(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
