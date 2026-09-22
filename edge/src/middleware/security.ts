/** Security headers and request ids (CLAUDE.md §11). */

import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../types'

export const requestId = createMiddleware<AppEnv>(async (c, next) => {
  c.set('requestId', crypto.randomUUID())
  await next()
})

export const securityHeaders = createMiddleware<AppEnv>(async (c, next) => {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  // The UI is self-contained: no third-party scripts, styles or frames. A
  // strict policy costs nothing here and closes off injected-script routes to
  // your club data.
  c.header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
      "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  )
  // Club data is personal. Never let a shared cache hold it.
  if (c.req.path.startsWith('/api/')) c.header('Cache-Control', 'no-store')
})
