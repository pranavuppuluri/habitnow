/**
 * Web Push with nothing but node:crypto, so the server stays dependency-free.
 *
 * Two standards do the work:
 *   RFC 8292 (VAPID): each request carries a short JWT signed with this
 *     server's own P-256 key, so the push service knows who is sending.
 *   RFC 8291 (message encryption): the payload is encrypted to the browser's
 *     key with aes128gcm (RFC 8188), so the push service cannot read it.
 */
import { createCipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from 'node:crypto'

const b64url = (buf) => Buffer.from(buf).toString('base64url')
const fromB64url = (str) => Buffer.from(str, 'base64url')

/** A fresh VAPID key pair: the public key as the browser wants it, the private key as a JWK. */
export function generateVapidKeys() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = privateKey.export({ format: 'jwk' })
  const publicKey = b64url(Buffer.concat([Buffer.from([4]), fromB64url(jwk.x), fromB64url(jwk.y)]))
  return { publicKey, privateJwk: jwk }
}

/** The Authorization header for one push service origin, valid for 12 hours. */
export function vapidAuthorization(endpoint, vapid, subject, now = Date.now()) {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))
  const claims = b64url(
    JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }),
  )
  const key = createPrivateKey({ key: vapid.privateJwk, format: 'jwk' })
  // JOSE wants the raw r||s signature, not DER.
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${vapid.publicKey}`
}

function freshKeys() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return ecdh
}

/**
 * Encrypts a payload to a subscription's keys (RFC 8291), giving the request
 * body: salt, record size and the server's one-off public key, then the
 * ciphertext as a single aes128gcm record.
 */
export function encryptPayload(plaintext, keys, { salt = randomBytes(16), ecdh = freshKeys() } = {}) {
  const uaPublic = fromB64url(keys.p256dh)
  const authSecret = fromB64url(keys.auth)
  const asPublic = ecdh.getPublicKey()
  const shared = ecdh.computeSecret(uaPublic)

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))

  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  // 0x02 marks the last (and only) record.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])

  const recordSize = Buffer.alloc(4)
  recordSize.writeUInt32BE(4096)
  return Buffer.concat([salt, recordSize, Buffer.from([asPublic.length]), asPublic, body])
}

/**
 * Sends one notification. Resolves to 'sent', or 'gone' when the push service
 * says the subscription no longer exists and should be forgotten.
 */
export async function sendPush(subscription, payload, vapid, subject, { ttl = 3600, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidAuthorization(subscription.endpoint, vapid, subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: 'normal',
    },
    body: encryptPayload(JSON.stringify(payload), subscription.keys),
  })
  if (res.status === 404 || res.status === 410) return 'gone'
  if (!res.ok) throw new Error(`Push service answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return 'sent'
}
