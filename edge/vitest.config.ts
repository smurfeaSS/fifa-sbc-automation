import { defineConfig } from 'vitest/config'

/**
 * Node-environment tests: the solver and the Access JWT logic, both of which
 * use only Web Crypto and fetch. Running them here keeps them fast and
 * exercises the real signature path rather than a stub.
 *
 * Tests that need actual Workers runtime APIs (HTMLRewriter, D1) live in
 * tests/workers/ and run under vitest.workers.config.ts instead.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/*.test.ts'],
  },
})
