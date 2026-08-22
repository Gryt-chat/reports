import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
} from "jose";

import { checkAppKey, REPORT_AUDIENCE, verifyIdentity } from "./auth.ts";
import { closeDb, initDb } from "./db.ts";
import type { HttpError } from "./http.ts";

const keys = new Map([["mobile", "secret-key"]]);

test("app key: the right key gets in", () => {
  assert.equal(checkAppKey("mobile", "secret-key", keys, false), "mobile");
});

test("app key: a wrong, missing or unknown one does not", () => {
  const codes = [
    [null, "secret-key", "missing_app"],
    ["mobile", "wrong", "bad_app_key"],
    ["mobile", null, "bad_app_key"],
    // An app nobody configured answers the same as a wrong key on purpose.
    // Two answers would let a stranger learn which app ids exist by asking.
    ["desktop", "secret-key", "bad_app_key"],
    ["Mobile!", "secret-key", "invalid_app"],
  ] as const;

  for (const [app, key, code] of codes) {
    assert.throws(
      () => checkAppKey(app, key, keys, false),
      (err: HttpError) => err.code === code,
      `${app}/${key} should be ${code}`,
    );
  }
});

test("app key: unkeyed mode takes whatever app says it is", () => {
  assert.equal(checkAppKey("cli", null, new Map(), true), "cli");
  assert.equal(checkAppKey(null, null, new Map(), true), "unknown");
});

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "gryt-reports-test-"));
  initDb(dir);
});

after(() => closeDb());

interface Signer {
  privateKey: CryptoKey;
  publicJwk: JWK;
  thumbprint: string;
}

async function makeSigner(): Promise<Signer> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  return {
    privateKey,
    publicJwk,
    thumbprint: await calculateJwkThumbprint(publicJwk, "sha256"),
  };
}

async function sign(
  signer: Signer,
  body: Buffer,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  return new SignJWT({
    bh: createHash("sha256").update(body).digest("base64url"),
    ...overrides,
  })
    .setProtectedHeader({ alg: "ES256", jwk: signer.publicJwk })
    .setSubject(String(overrides.sub ?? signer.thumbprint))
    .setIssuedAt()
    .setJti(String(overrides.jti ?? randomUUID()))
    .setAudience(String(overrides.aud ?? REPORT_AUDIENCE))
    .setExpirationTime("5m")
    .sign(signer.privateKey);
}

test("signature: a report signed by a real key verifies to its thumbprint", async () => {
  const signer = await makeSigner();
  const body = Buffer.from(JSON.stringify({ type: "bug", message: "hi" }));

  const identity = await verifyIdentity(await sign(signer, body), body);
  assert.equal(identity.subject, signer.thumbprint);
});

test("signature: the same assertion cannot be used twice", async () => {
  const signer = await makeSigner();
  const body = Buffer.from("{}");
  const token = await sign(signer, body);

  await verifyIdentity(token, body);
  await assert.rejects(
    () => verifyIdentity(token, body),
    (err: HttpError) => err.code === "replayed_assertion",
  );
});

test("signature: it is bound to the body it was signed over", async () => {
  const signer = await makeSigner();
  const token = await sign(signer, Buffer.from('{"message":"one"}'));

  await assert.rejects(
    () => verifyIdentity(token, Buffer.from('{"message":"two"}')),
    (err: HttpError) => err.code === "bad_signature",
  );
});

test("signature: a subject that is not the key's thumbprint is refused", async () => {
  const signer = await makeSigner();
  const body = Buffer.from("{}");
  const token = await sign(signer, body, { sub: "somebody-elses-id" });

  await assert.rejects(
    () => verifyIdentity(token, body),
    (err: HttpError) => err.code === "bad_signature",
  );
});

test("signature: an assertion made for something else does not work here", async () => {
  const signer = await makeSigner();
  const body = Buffer.from("{}");
  const token = await sign(signer, body, { aud: "gryt:server" });

  await assert.rejects(
    () => verifyIdentity(token, body),
    (err: HttpError) => err.code === "bad_signature",
  );
});

/**
 * The assertion the mobile app actually builds.
 *
 * Written out here rather than reusing the helper above, on purpose: this is a
 * contract with another repository, and the point is to fail when either side
 * drifts. Every value below mirrors `src/feedback/claims.ts` and
 * `src/identity/keys.ts` in Gryt-chat/mobile — the bare thumbprint as `sub`
 * (not the `key:`-prefixed subject that file also exports), the canonical
 * member order, and the 120-second lifetime.
 */
async function mobileShapedAssertion(
  signer: Signer,
  body: Buffer,
  iatSeconds: number,
): Promise<string> {
  const canonical = JSON.stringify({
    crv: signer.publicJwk.crv,
    kty: signer.publicJwk.kty,
    x: signer.publicJwk.x,
    y: signer.publicJwk.y,
  });

  return new SignJWT({
    sub: createHash("sha256").update(canonical).digest("base64url"),
    aud: REPORT_AUDIENCE,
    bh: createHash("sha256").update(body).digest("base64url"),
    jti: randomUUID(),
    iat: iatSeconds,
    exp: iatSeconds + 120,
  })
    .setProtectedHeader({ alg: "ES256", jwk: signer.publicJwk })
    .sign(signer.privateKey);
}

test("the assertion the mobile app builds is the one this accepts", async () => {
  const signer = await makeSigner();
  const body = Buffer.from(JSON.stringify({ type: "bug", message: "from the phone" }));
  const now = Math.floor(Date.now() / 1000);

  const identity = await verifyIdentity(await mobileShapedAssertion(signer, body, now), body);
  assert.equal(identity.subject, signer.thumbprint, "both sides compute the same thumbprint");
});

test("a phone with a slightly fast clock is not a stranger", async () => {
  const signer = await makeSigner();
  const body = Buffer.from("{}");
  const now = Math.floor(Date.now() / 1000);

  // Thirty seconds ahead is an ordinary handset, and this used to be a 401.
  // The client sends the assertion whenever it can build one, so refusing it
  // loses the whole report rather than only the signature.
  await verifyIdentity(await mobileShapedAssertion(signer, body, now + 30), body);

  // Far enough out that the assertion's own two minutes have expired.
  const stale = await mobileShapedAssertion(signer, body, now - 240);
  await assert.rejects(
    () => verifyIdentity(stale, body),
    (err: HttpError) => err.code === "bad_signature",
  );
});
