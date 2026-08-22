import consola from "consola";
import { createHash } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import { calculateJwkThumbprint, EmbeddedJWK, jwtVerify, type JWK } from "jose";

import { claimAssertion } from "./db.ts";
import { HttpError } from "./http.ts";

/**
 * The audience every report assertion has to name.
 *
 * A signature collected by something else — a Gryt server's join handshake,
 * say — must not be replayable here, and this is what stops it.
 */
export const REPORT_AUDIENCE = "gryt:reports";

/** How stale an assertion may be before it is refused. */
const MAX_ASSERTION_AGE = "5m";

/**
 * How wrong a phone's clock may be.
 *
 * Without this, an `iat` one second in the future is refused outright, and a
 * handset thirty seconds fast is ordinary rather than suspicious. The cost of
 * being strict is not a rejected signature — the client sends the assertion
 * whenever it can build one, so a refusal loses the whole report, from exactly
 * the person who was trying to say something is broken.
 *
 * A minute either way buys nothing for anyone attacking this: the assertion is
 * still bound to one body and its `jti` is still good once.
 */
const CLOCK_TOLERANCE = "60s";

/**
 * Which app is submitting, and whether it proved it.
 *
 * The key is a shared secret shipped inside a client binary, which is friction
 * rather than authentication: anyone can pull it out of an app bundle or read
 * one request in a proxy. What it buys is that a scanner finding an open POST
 * endpoint cannot fill the table overnight, and that a leaked key can be
 * rotated for one app without shipping the others.
 *
 * The thing that actually authenticates is the signature below.
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

  // One answer for "no such app" and "wrong key", because two answers tell a
  // stranger which app ids exist. Whoever is holding a real key knows which
  // one it is; nobody else needs to learn the list by asking.
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
 * Verify that whoever posted this holds a Gryt identity key.
 *
 * Every client already has one — joining a server is a signed challenge, and
 * the same key signs this. What that buys over the app key: repeat submissions
 * from one key can be tied together without collecting anything about the
 * person behind it, and an abuser can be banned by key rather than by whatever
 * IP they happened to be on.
 *
 * There is no challenge round trip, so replay is prevented by three things
 * instead: the assertion is bound to this exact body through `bh`, it expires
 * in five minutes, and its `jti` is good exactly once.
 *
 * The identifier stored is the key's thumbprint, not a Gryt server's derived
 * subject. This service authorises nothing on any server, so it has no need to
 * agree with a server's namespace — and the thumbprint is what those subjects
 * are derived from anyway.
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
    // The library's own message describes how the check works — which expiry
    // was missed, which claim was wrong — to somebody who has not proved
    // anything. It goes in the log, where it helps; the answer says the one
    // thing the caller is entitled to.
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
