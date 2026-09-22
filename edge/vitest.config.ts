import { defineConfig } from 'vitest/config'

// Plain Node environment: the code under test uses only Web Crypto and fetch,
// both of which Node 22 provides natively. That keeps these tests fast and
// exercises the real signature path rather than a stub.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
