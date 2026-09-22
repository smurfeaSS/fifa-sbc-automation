/**
 * Cloudflare Access verification tests.
 *
 * This is the boundary between "my club data" and "the internet", so the tests
 * are written as attacks rather than as happy paths: each one is a way a
 * request could try to get through without being the allowlisted identity.
 */

import { describe, test, expect, beforeAll, vi } from 'vitest'
import { verifyAccessJwt, AccessDeniedError } from '../src/middleware/access'
import type { Bindings } from '../src/types'

const TEAM = 'testteam'
const ISSUER = `https://${TEAM}.cloudflareaccess.com`
const AUD = 'a'.repeat(64)
const EMAIL = 'mariosxen7@icloud.com'

let keyPair: CryptoKeyPair
let jwk: JsonWebKey
const KID = 'test-key-1'

function b64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === 'string'
    ? bytes
    : String.fromCharCode(...bytes)
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Sign a JWT with the test key, or corrupt it deliberately. */
async function makeJwt(
  claims: Record<string, unknown>,
  opts: { alg?: string; kid?: string; tamper?: boolean } = {},
): Promise<string> {
  const header = b64url(JSON.stringify({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? KID, typ: 'JWT' }))
  const payload = b64url(JSON.stringify(claims))
  const data = new TextEncoder().encode(`${header}.${payload}`)
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, data)
  let signature = b64url(new Uint8Array(sig))
  if (opts.tamper) {
    // Flip a character so the signature no longer matches the payload.
    signature = signature.slice(0, -2) + (signature.at(-2) === 'A' ? 'B' : 'A') + signature.at(-1)
  }
  return `${header}.${payload}.${signature}`
}

function validClaims(over: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000)
  return { aud: [AUD], email: EMAIL, exp: now + 3600, iat: now, iss: ISSUER, sub: 'user-1', ...over }
}

/** Env with a KV stub that never caches, so every call re-reads the JWKS. */
function makeEnv(over: Partial<Bindings> = {}): Bindings {
  return {
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ALLOWED_EMAIL: EMAIL,
    CACHE: {
      get: async () => null,
      put: async () => undefined,
    } as unknown as KVNamespace,
    ...over,
  } as Bindings
}

beforeAll(async () => {
  // workers-types declares these as unions covering the symmetric cases, so
  // the casts narrow to what RSA actually returns.
  keyPair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  jwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey

  // Serve our test key where Access's JWKS would be.
  vi.stubGlobal('fetch', async (url: string) => {
    if (String(url).includes('/cdn-cgi/access/certs')) {
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: 'RS256' }] }), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  })
})

describe('accepts only a genuine Access token', () => {
  test('a correctly signed token for the right app and identity passes', async () => {
    const token = await makeJwt(validClaims())
    const claims = await verifyAccessJwt(token, makeEnv())
    expect(claims.email).toBe(EMAIL)
  })
})

describe('rejects forged and malformed tokens', () => {
  test('rubbish that is not a JWT', async () => {
    await expect(verifyAccessJwt('not-a-jwt', makeEnv())).rejects.toThrow(AccessDeniedError)
  })

  test('a tampered payload invalidates the signature', async () => {
    const token = await makeJwt(validClaims(), { tamper: true })
    await expect(verifyAccessJwt(token, makeEnv())).rejects.toThrow(/signature/i)
  })

  test('alg: none is refused rather than trusted', async () => {
    // The classic forgery: claim no algorithm and hope the verifier skips the
    // signature check entirely.
    const header = b64url(JSON.stringify({ alg: 'none', kid: KID, typ: 'JWT' }))
    const payload = b64url(JSON.stringify(validClaims()))
    await expect(verifyAccessJwt(`${header}.${payload}.`, makeEnv()))
      .rejects.toThrow(/algorithm/i)
  })

  test('HS256 is refused, so a public key cannot be used as an HMAC secret', async () => {
    const token = await makeJwt(validClaims(), { alg: 'HS256' })
    await expect(verifyAccessJwt(token, makeEnv())).rejects.toThrow(/algorithm/i)
  })

  test('a token signed by an unknown key is refused', async () => {
    const token = await makeJwt(validClaims(), { kid: 'some-other-key' })
    await expect(verifyAccessJwt(token, makeEnv())).rejects.toThrow(/unknown key/i)
  })
})

describe('rejects valid signatures with wrong claims', () => {
  test('an expired token', async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = await makeJwt(validClaims({ exp: now - 3600 }))
    await expect(verifyAccessJwt(token, makeEnv())).rejects.toThrow(/expired/i)
  })

  test('a token that is not yet valid', async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = await makeJwt(validClaims({ nbf: now + 3600 }))
    await expect(verifyAccessJwt(token, makeEnv())).rejects.toThrow(/not yet valid/i)
  })

  test('a token from a different Access team', async () => {
    const token = await makeJwt(validClaims({ iss: 'https://someoneelse.cloudflareaccess.com' }))
    await expect(verifyAccessJwt(token, makeEnv())).rejects.toThrow(/issuer/i)
  })

  test('a token for a different application in the same account', async () => {
    // Without the aud check this would pass: same team, same signing key, but
    // issued by an Access app protecting something else entirely.
    const token = await makeJwt(validClaims({ aud: ['b'.repeat(64)] }))
    await expect(verifyAccessJwt(token, makeEnv())).rejects.toThrow(/different application/i)
  })
})

describe('refuses to run misconfigured', () => {
  test('an unset team domain fails closed', async () => {
    const token = await makeJwt(validClaims())
    await expect(verifyAccessJwt(token, makeEnv({ ACCESS_TEAM_DOMAIN: 'REPLACE_WITH_YOUR_TEAM_NAME' })))
      .rejects.toThrow(/not configured/i)
  })

  test('an unset AUD fails closed rather than skipping the check', async () => {
    const token = await makeJwt(validClaims())
    await expect(verifyAccessJwt(token, makeEnv({ ACCESS_AUD: '' })))
      .rejects.toThrow(/not configured/i)
  })
})
