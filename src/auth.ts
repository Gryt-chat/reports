import consola from "consola";
import { createHash } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import { calculateJwkThumbprint, EmbeddedJWK, jwtVerify, type JWK } from "jose";

import { claimAssertion } from "./db.ts";
import { HttpError } from "./http.ts";

/**
 * The audience every report assertion has to name. A signature collected by something else —
 * a Gryt server's join handshake — must not be replayable here.
 */
export const REPORT_AUDIENCE = "gryt:reports";

/** How stale an assertion may be before it is refused. */
const MAX_ASSERTION_AGE = "5m";

/**
 * How wrong a phone's clock may be. Refusing costs the whole report, from the person trying
 * to say something is broken; a minute buys an attacker nothing, since `jti` is good once.
 */
const CLOCK_TOLERANCE = "60s";

/**
 * Which app is submitting, and whether it proved it. The key is friction rather than
 * authentication; what actually authenticates is the signature below.
 */
export function checkAppKey(
  appId: string | null,
  appKey: string | null,
  keys: Map<string, string>,
  allowUnkeyed: boolean,
): string {
  if (!appId) {
    if (allowUnkeyed) return "unknown";
    throw new HttpError(401, "missing_app", "X-Gryt-App header is required");
  }

  if (!/^[a-z0-9][a-z0-9._-]{0,30}$/.test(appId)) {
    throw new HttpError(400, "invalid_app", "X-Gryt-App is not a valid app id");
  }

  if (allowUnkeyed && keys.size === 0) return appId;

  // One answer for "no such app" and "wrong key", because two answers tell a stranger which
  // app ids exist. Whoever holds a real key knows which one it is.
  const expected = keys.get(appId);
  if (!expected || !appKey || !constantTimeEquals(appKey, expected)) {
    throw new HttpError(401, "bad_app_key", "X-Gryt-App-Key is wrong or missing");
  }

  return appId;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface VerifiedIdentity {
  /** The RFC 7638 thumbprint of the key that signed. Stable, and not a person. */
  subject: string;
}

/**
 * Verify that whoever posted this holds a Gryt identity key. No challenge round trip, so
 * three things stop replay together: `bh` binds the body, five minutes, and `jti` once.
 */
export async function verifyIdentity(
  token: string,
  body: Buffer,
): Promise<VerifiedIdentity> {
  let payload;
  let protectedHeader;

  try {
    ({ payload, protectedHeader } = await jwtVerify(token, EmbeddedJWK, {
      algorithms: ["ES256"],
      audience: REPORT_AUDIENCE,
      maxTokenAge: MAX_ASSERTION_AGE,
      clockTolerance: CLOCK_TOLERANCE,
      requiredClaims: ["sub", "jti", "iat", "exp"],
    }));
  } catch (err) {
    // The library's own message describes how the check works to somebody who has proved
    // nothing. It goes in the log; the answer says what the caller is entitled to.
    consola.debug(`[auth] Assertion rejected: ${(err as Error).message}`);
    throw new HttpError(401, "bad_signature", "Identity assertion did not verify");
  }

  const jwk = protectedHeader.jwk as JWK | undefined;
  if (!jwk) {
    throw new HttpError(401, "bad_signature", "Assertion carries no public key");
  }

  const thumbprint = await calculateJwkThumbprint(jwk, "sha256");
  if (payload.sub !== thumbprint) {
    throw new HttpError(
      401,
      "bad_signature",
      "Assertion subject is not this key's thumbprint",
    );
  }

  const digest = createHash("sha256").update(body).digest("base64url");
  if (payload.bh !== digest) {
    throw new HttpError(
      401,
      "bad_signature",
      "Assertion was not signed over this body",
    );
  }

  const jti = String(payload.jti);
  const expiresAt = Number(payload.exp) * 1000;
  if (!claimAssertion(jti, expiresAt)) {
    throw new HttpError(401, "replayed_assertion", "This assertion has been used");
  }

  return { subject: thumbprint };
}
