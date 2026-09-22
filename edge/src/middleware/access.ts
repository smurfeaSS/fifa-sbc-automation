/**
 * Cloudflare Access authentication.
 *
 * WHY THIS EXISTS AT ALL
 *
 * It is tempting to assume that because Access sits in front of the domain, the
 * Worker can trust every request that reaches it. That assumption is wrong, in
 * two ways:
 *
 *  1. Every Worker also gets a `<name>.<subdomain>.workers.dev` hostname, which
 *     Access does not cover. `workers_dev = false` in wrangler.toml disables it,
 *     but a future deploy or a dashboard toggle can put it back.
 *  2. Access is configured separately from this code. A mistyped policy, an
 *     application deleted and recreated, or a route that no longer matches
 *     leaves the Worker exposed with no sign anything changed.
 *
 * So the Worker verifies the assertion itself. Two independent things must both
 * hold before any club data is touched: Access must have issued a valid signed
 * token for this exact application, and the identity inside it must be the one
 * address on the allowlist.
 *
 * WHAT IS VERIFIED
 *
 *  - The JWT is RS256, signed by a current Access public key for your team.
 *  - `iss` matches your team's Access domain.
 *  - `aud` contains this application's AUD tag. Without this check any Access
 *    application in your account — including one protecting something else
 *    entirely — would mint tokens this Worker accepts.
 *  - `exp` and `nbf` are honoured, with a small clock skew allowance.
 *  - `email` equals ALLOWED_EMAIL, compared case-insensitively.
 *
 * Nothing here trusts a header that a client could set by hand: the signature
 * is what makes the claims meaningful, and it is checked before they are read.
 */

import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../types'

/** Access sends the assertion in this header, and also in this cookie. */
const JWT_HEADER = 'Cf-Access-Jwt-Assertion'
const JWT_COOKIE = 'CF_Authorization'

/** Tolerance for clock drift between Cloudflare's edge and this isolate. */
const CLOCK_SKEW_SECONDS = 60

/** How long to cache the JWKS. Access rotates keys roughly every 6 weeks. */
const JWKS_CACHE_SECONDS = 3600
const JWKS_CACHE_KEY = 'access:jwks:v1'

interface AccessJwk {
  kid: string
  kty: string
  alg: string
  use?: string
  n: string
  e: string
}

interface AccessClaims {
  aud: string[] | string
  email?: string
  exp: number
  iat: number
  nbf?: number
  iss: string
  sub: string
  identity_nonce?: string
}

/** Thrown for every rejection. The message is logged, never returned verbatim. */
export class AccessDeniedError extends Error {
  constructor(public readonly detail: string) {
    super(detail)
    this.name = 'AccessDeniedError'
  }
}

// ─── base64url ────────────────────────────────────────────────────────────────

function base64UrlToBytes(input: string): Uint8Array {
  // Workers have atob but not Buffer. Restore standard base64 padding first.
  const normalised = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalised.padEnd(normalised.length + ((4 - (normalised.length % 4)) % 4), '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function base64UrlToString(input: string): string {
  return new TextDecoder().decode(base64UrlToBytes(input))
}

// ─── JWKS ─────────────────────────────────────────────────────────────────────

function teamDomain(env: AppEnv['Bindings']): string {
  const team = env.ACCESS_TEAM_DOMAIN?.trim()
  if (!team || team.startsWith('REPLACE_WITH')) {
    throw new AccessDeniedError('ACCESS_TEAM_DOMAIN is not configured')
  }
  // Accept either "myteam" or a full "myteam.cloudflareaccess.com".
  return team.includes('.') ? team : `${team}.cloudflareaccess.com`
}

/**
 * Fetch Access's public keys, cached in KV.
 *
 * On a cache miss this costs one subrequest. Caching matters because it happens
 * on the first request of every cold isolate, and JWKS latency would otherwise
 * be added to page loads.
 */
async function getJwks(env: AppEnv['Bindings']): Promise<AccessJwk[]> {
  const cached = await env.CACHE.get(JWKS_CACHE_KEY, 'json').catch(() => null)
  if (cached && Array.isArray(cached)) return cached as AccessJwk[]

  const url = `https://${teamDomain(env)}/cdn-cgi/access/certs`
  const res = await fetch(url, { cf: { cacheTtl: JWKS_CACHE_SECONDS, cacheEverything: true } })
  if (!res.ok) {
    throw new AccessDeniedError(`could not fetch Access keys: HTTP ${res.status}`)
  }

  const body = (await res.json()) as { keys?: AccessJwk[] }
  const keys = body.keys ?? []
  if (keys.length === 0) {
    throw new AccessDeniedError('Access returned no signing keys')
  }

  // Failing to cache is not fatal — verification still works, just slower.
  await env.CACHE.put(JWKS_CACHE_KEY, JSON.stringify(keys), {
    expirationTtl: JWKS_CACHE_SECONDS,
  }).catch(() => undefined)

  return keys
}

async function importKey(jwk: AccessJwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )
}

// ─── verification ─────────────────────────────────────────────────────────────

/**
 * Verify an Access JWT and return its claims.
 * Throws AccessDeniedError on any failure; never returns unverified claims.
 */
export async function verifyAccessJwt(
  token: string,
  env: AppEnv['Bindings'],
): Promise<AccessClaims> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new AccessDeniedError('malformed token')

  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string]

  let header: { alg?: string; kid?: string }
  try {
    header = JSON.parse(base64UrlToString(rawHeader))
  } catch {
    throw new AccessDeniedError('unreadable token header')
  }

  // Pin the algorithm. Accepting whatever the token names is how "alg: none"
  // and HMAC-key-confusion attacks work.
  if (header.alg !== 'RS256') {
    throw new AccessDeniedError(`unexpected algorithm: ${header.alg}`)
  }
  if (!header.kid) throw new AccessDeniedError('token has no key id')

  const jwks = await getJwks(env)
  const jwk = jwks.find((k) => k.kid === header.kid)
  if (!jwk) throw new AccessDeniedError('token signed by an unknown key')

  const key = await importKey(jwk)
  const signature = base64UrlToBytes(rawSignature)
  const signedData = new TextEncoder().encode(`${rawHeader}.${rawPayload}`)

  const signatureValid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    signature as BufferSource,
    signedData as BufferSource,
  )
  if (!signatureValid) throw new AccessDeniedError('bad signature')

  // Only now are the claims worth reading.
  let claims: AccessClaims
  try {
    claims = JSON.parse(base64UrlToString(rawPayload))
  } catch {
    throw new AccessDeniedError('unreadable token payload')
  }

  const now = Math.floor(Date.now() / 1000)
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < now) {
    throw new AccessDeniedError('token expired')
  }
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_SECONDS > now) {
    throw new AccessDeniedError('token not yet valid')
  }

  const expectedIssuer = `https://${teamDomain(env)}`
  if (claims.iss !== expectedIssuer) {
    throw new AccessDeniedError(`wrong issuer: ${claims.iss}`)
  }

  // Without this, a token from any other Access application in the same account
  // would be accepted here.
  const expectedAud = env.ACCESS_AUD?.trim()
  if (!expectedAud || expectedAud.startsWith('REPLACE_WITH')) {
    throw new AccessDeniedError('ACCESS_AUD is not configured')
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!audiences.includes(expectedAud)) {
    throw new AccessDeniedError('token issued for a different application')
  }

  return claims
}

// ─── middleware ───────────────────────────────────────────────────────────────

function cookieValue(cookieHeader: string, name: string): string | undefined {
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim()
    if (trimmed.startsWith(`${name}=`)) return trimmed.slice(name.length + 1)
  }
  return undefined
}

/**
 * Require a verified Access identity matching ALLOWED_EMAIL.
 *
 * Apply to everything that reads or writes club data. Rejections return a bare
 * 403 — the reason goes to the log, not to the caller, since telling an
 * unauthenticated client *why* it failed helps only an attacker.
 */
export const requireAccess = createMiddleware<AppEnv>(async (c, next) => {
  const token =
    c.req.header(JWT_HEADER) ??
    cookieValue(c.req.header('Cookie') ?? '', JWT_COOKIE)

  if (!token) {
    console.warn(`[access] no assertion on ${c.req.path}`)
    return c.json(
      { success: false, error: 'Forbidden', code: 'NO_ACCESS_TOKEN', requestId: c.get('requestId') ?? 'unknown' },
      403,
    )
  }

  let claims: AccessClaims
  try {
    claims = await verifyAccessJwt(token, c.env)
  } catch (e) {
    const detail = e instanceof AccessDeniedError ? e.detail : String(e)
    console.warn(`[access] rejected on ${c.req.path}: ${detail}`)
    return c.json(
      { success: false, error: 'Forbidden', code: 'INVALID_ACCESS_TOKEN', requestId: c.get('requestId') ?? 'unknown' },
      403,
    )
  }

  const allowed = c.env.ALLOWED_EMAIL?.trim().toLowerCase()
  const actual = claims.email?.trim().toLowerCase()

  if (!allowed) {
    console.error('[access] ALLOWED_EMAIL is not configured — refusing all requests')
    return c.json(
      { success: false, error: 'Forbidden', code: 'MISCONFIGURED', requestId: c.get('requestId') ?? 'unknown' },
      403,
    )
  }
  if (!actual || actual !== allowed) {
    // A valid token for the wrong person. Worth logging loudly: it means the
    // Access policy is broader than this Worker's allowlist.
    console.warn(`[access] valid token for non-allowlisted identity: ${actual ?? '(no email)'}`)
    return c.json(
      { success: false, error: 'Forbidden', code: 'NOT_ALLOWLISTED', requestId: c.get('requestId') ?? 'unknown' },
      403,
    )
  }

  c.set('userEmail', actual)
  await next()
  return
})
