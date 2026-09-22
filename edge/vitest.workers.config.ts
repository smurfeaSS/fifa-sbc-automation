import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

/**
 * Tests that need the real Workers runtime.
 *
 * HTMLRewriter has no Node equivalent, so the scraper cannot be meaningfully
 * tested anywhere else — a hand-rolled stub would test the stub, not the
 * streaming semantics (chunked text nodes, onEndTag ordering) that the parser
 * actually depends on.
 */
export default defineWorkersConfig({
  test: {
    include: ['tests/workers/**/*.test.ts'],
    poolOptions: {
      workers: {
        miniflare: { compatibilityDate: '2024-09-23', compatibilityFlags: ['nodejs_compat'] },
      },
    },
  },
})
