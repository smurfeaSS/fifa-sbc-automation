/**
 * FC 27 Smart SBC Assistant — Cloudflare Workers edition.
 *
 * Runtime: V8 isolate, not Node. See the cloudflare-edge CLAUDE.md for the
 * constraints this app is built against; the two that shaped it most are the
 * 10ms CPU budget per request and the rule against loading large datasets into
 * memory.
 *
 * ACCESS MODEL
 *   Everything except /health requires a verified Cloudflare Access identity
 *   matching ALLOWED_EMAIL. That includes the static UI — there is no reason to
 *   serve the dashboard shell to an unauthenticated visitor, and doing so would
 *   leak the app's existence and shape.
 */

import { Hono } from 'hono'
import { timing } from 'hono/timing'

import type { AppEnv } from './types'
import { requestId, securityHeaders } from './middleware/security'
import { requireAccess } from './middleware/access'

import importRoutes from './routes/import'
import solveRoutes from './routes/solve'
import clubRoutes from './routes/club'
import manageRoutes from './routes/manage'

const app = new Hono<AppEnv>()

app.use('*', requestId)
app.use('*', timing())
app.use('*', securityHeaders)

/**
 * Health check, deliberately unauthenticated and deliberately empty.
 *
 * It reports that the Worker is running and nothing else — no version, no
 * binding status, no club state. An unauthenticated endpoint that describes
 * your deployment is a reconnaissance gift.
 */
app.get('/health', (c) => c.json({ ok: true }))

// ─── Everything below requires a verified Access identity ────────────────────
app.use('/api/*', requireAccess)

app.route('/api/import', importRoutes)
app.route('/api/solve', solveRoutes)
app.route('/api/club', clubRoutes)
app.route('/api', manageRoutes)

// Static UI, also behind Access.
app.use('*', requireAccess)
app.get('*', async (c) => {
  try {
    return await c.env.ASSETS.fetch(c.req.raw)
  } catch {
    return c.json(
      { success: false, error: 'Not Found', code: 'NOT_FOUND', requestId: c.get('requestId') },
      404,
    )
  }
})

app.onError((err, c) => {
  const id = c.get('requestId') ?? 'unknown'
  console.error(`[${id}] ${err.message}`, err.stack)
  // Never return a stack trace (CLAUDE.md §11). The request id is the link
  // between what the user sees and what `wrangler tail` shows.
  return c.json(
    { success: false, error: 'Internal Server Error', code: 'INTERNAL', requestId: id },
    500,
  )
})

app.notFound((c) =>
  c.json({ success: false, error: 'Not Found', code: 'NOT_FOUND', requestId: c.get('requestId') }, 404),
)

export default app
