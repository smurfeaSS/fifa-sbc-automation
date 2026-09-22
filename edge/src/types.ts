/** Bindings must match wrangler.toml exactly (case-sensitive). */
export type Bindings = {
  DB: D1Database
  ACCESS_KEYS: KVNamespace
  ASSETS: Fetcher

  APP_NAME: string
  APP_ENV: string
  LOG_LEVEL: string

  /** The only address permitted to use this deployment. */
  ALLOWED_EMAIL: string
  /** Zero Trust team name, for the JWKS and issuer URLs. */
  ACCESS_TEAM_DOMAIN: string
  /** The Access application's AUD tag. */
  ACCESS_AUD: string
}

/** Per-request state. */
export type Variables = {
  /** Set only after the Access JWT has been verified. */
  userEmail: string
  requestId: string
}

export type AppEnv = {
  Bindings: Bindings
  Variables: Variables
}

export type ApiResponse<T = unknown> =
  | { success: true; data: T; requestId: string }
  | { success: false; error: string; code: string; requestId: string }
