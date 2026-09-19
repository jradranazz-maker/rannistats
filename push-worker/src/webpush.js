/* Web Push, implemented on WebCrypto alone.
 *
 * Why hand-rolled instead of the `web-push` npm package: that package wants
 * Node's crypto module, which Workers don't have. There are Worker-compatible
 * forks, but this is ~150 lines of standard-track crypto with published test
 * vectors, and keeping it dependency-free means the Worker is a single file to
 * deploy, with nothing to audit but what's here.
 *
 * Two specs are in play:
 *   RFC 8291 — Message Encryption for Web Push. Encrypts the payload so the
 *     push service (Google, Apple, Mozilla) relays it without being able to
 *     read it. ECDH P-256 -> HKDF -> AES-128-GCM, "aes128gcm" framing.
 *   RFC 8292 — VAPID. A signed JWT that identifies this application server to
 *     the push service, so our endpoints can't be used by anyone else.
 *
 * verifyAgainstRfcVectors() at the bottom reproduces RFC 8291's own worked
 * example, which is what the test suite runs.
 */

const enc = new TextEncoder();

/* ---- base64url ---------------------------------------------------------- */
export function b64urlToBytes(s) {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function bytesToB64url(bytes) {
  let bin = "";
  const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
function u32be(n) { return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]); }

/* ---- HKDF (RFC 5869), the two steps kept separate because RFC 8291 uses
        extract and expand at different points with different salts --------- */
async function hkdfExtract(salt, ikm) {
  const key = await crypto.subtle.importKey("raw", salt, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, ikm));
}
async function hkdfExpand(prk, info, length) {
  const key = await crypto.subtle.importKey("raw", prk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  // Every output here is <= 32 bytes, so a single round (T(1)) is enough.
  const t = new Uint8Array(await crypto.subtle.sign("HMAC", key, concat(info, new Uint8Array([1]))));
  return t.slice(0, length);
}

/* ---- P-256 keys --------------------------------------------------------- */
// Subscriptions give us the user agent's public key as a raw uncompressed
// point (65 bytes, 0x04 || X || Y), which is what WebCrypto's "raw" format is.
async function importPublicKey(raw) {
  return crypto.subtle.importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, true, []);
}
export async function generateKeyPair(usage) {
  const alg = usage === "sign"
    ? { name: "ECDSA", namedCurve: "P-256" }
    : { name: "ECDH", namedCurve: "P-256" };
  const uses = usage === "sign" ? ["sign", "verify"] : ["deriveBits"];
  const kp = await crypto.subtle.generateKey(alg, true, uses);
  return {
    publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)),
    privateKeyJwk: await crypto.subtle.exportKey("jwk", kp.privateKey),
  };
}

/* ---- RFC 8291 payload encryption ---------------------------------------- */
/* Exposed with injectable salt and server keypair purely so the RFC's test
 * vectors can be reproduced exactly; production calls pass neither. */
export async function encryptPayload(plaintext, uaPublicRaw, authSecret, opts = {}) {
  const asPrivate = opts.asPrivateKey || null;
  let asPublicRaw = opts.asPublicRaw || null;
  let asPrivateKey = asPrivate;

  if (!asPrivateKey) {
    const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    asPrivateKey = kp.privateKey;
    asPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  }
  const salt = opts.salt || crypto.getRandomValues(new Uint8Array(16));

  const uaKey = await importPublicKey(uaPublicRaw);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asPrivateKey, 256)
  );

  // Step one: mix the shared secret with the subscription's auth secret. The
  // key_info binds the result to *both* public keys, so a payload encrypted
  // for one subscription can't be replayed at another.
  const prkKey = await hkdfExtract(authSecret, ecdhSecret);
  const keyInfo = concat(enc.encode("WebPush: info"), new Uint8Array([0]), uaPublicRaw, asPublicRaw);
  const ikm = await hkdfExpand(prkKey, keyInfo, 32);

  // Step two: the usual content-encoding derivation.
  const prk = await hkdfExtract(salt, ikm);
  const cek = await hkdfExpand(prk, concat(enc.encode("Content-Encoding: aes128gcm"), new Uint8Array([0])), 16);
  const nonce = await hkdfExpand(prk, concat(enc.encode("Content-Encoding: nonce"), new Uint8Array([0])), 12);

  // 0x02 is the padding delimiter for the last (only) record.
  const body = concat(
    typeof plaintext === "string" ? enc.encode(plaintext) : plaintext,
    new Uint8Array([2])
  );
  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, body)
  );

  // aes128gcm header: salt | record size | key id length | key id
  const recordSize = 4096;
  return concat(salt, u32be(recordSize), new Uint8Array([asPublicRaw.length]), asPublicRaw, ciphertext);
}

/* ---- RFC 8292 VAPID ----------------------------------------------------- */
export async function vapidAuthHeader(endpoint, privateKeyJwk, publicKeyRaw, subject) {
  const aud = new URL(endpoint).origin;
  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600, // spec caps this at 24h
    sub: subject,
  };
  const signingInput = bytesToB64url(enc.encode(JSON.stringify(header))) + "." +
                       bytesToB64url(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "jwk", { ...privateKeyJwk, key_ops: ["sign"] },
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
  );
  // WebCrypto already returns the raw r||s pair JWS wants — no DER unwrapping.
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signingInput))
  );
  const jwt = signingInput + "." + bytesToB64url(sig);
  return "vapid t=" + jwt + ", k=" + bytesToB64url(publicKeyRaw);
}

/* ---- one push ----------------------------------------------------------- */
/* Returns { ok, status, gone } — `gone` means the push service says this
 * subscription is dead (404/410) and the caller should delete it. That's the
 * only way subscriptions ever get cleaned up: browsers don't tell us when
 * someone uninstalls. */
export async function sendPush(subscription, payloadJson, vapid, fetchImpl = fetch) {
  const body = await encryptPayload(
    JSON.stringify(payloadJson),
    b64urlToBytes(subscription.keys.p256dh),
    b64urlToBytes(subscription.keys.auth)
  );
  const auth = await vapidAuthHeader(
    subscription.endpoint, vapid.privateKeyJwk, b64urlToBytes(vapid.publicKey), vapid.subject
  );
  const res = await fetchImpl(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "2419200",
      Urgency: payloadJson.urgency || "normal",
    },
    body,
  });
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}

/* ---- self-check against RFC 8291 section 5 ------------------------------ */
/* The RFC publishes a fully worked example: fixed keys, fixed salt, and the
 * exact expected output. If this reproduces it, the whole derivation chain is
 * right — which is worth far more than a test that only checks the code agrees
 * with itself. */
export async function verifyAgainstRfcVectors() {
  const plaintext = "When I grow up, I want to be a watermelon";
  const uaPublic = b64urlToBytes("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
  const authSecret = b64urlToBytes("BTBZMqHH6r4Tts7J_aSIgg");
  const salt = b64urlToBytes("DGv6ra1nlYgDCS1FRnbzlw");
  const asPublic = b64urlToBytes("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
  // Derive the JWK coordinates from the raw point rather than transcribing
  // them: an uncompressed P-256 point is 0x04 || X(32) || Y(32).
  const asPrivateJwk = {
    kty: "EC", crv: "P-256",
    d: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
    x: bytesToB64url(asPublic.slice(1, 33)),
    y: bytesToB64url(asPublic.slice(33, 65)),
    ext: true,
  };
  const expected = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

  const asPrivateKey = await crypto.subtle.importKey(
    "jwk", { ...asPrivateJwk, key_ops: ["deriveBits"] },
    { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]
  );
  const out = await encryptPayload(plaintext, uaPublic, authSecret, { salt, asPrivateKey, asPublicRaw: asPublic });
  const got = bytesToB64url(out);
  return { ok: got === expected, got, expected };
}
