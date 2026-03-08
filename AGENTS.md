# AGENTS.md

## Cursor Cloud specific instructions

**deep-trace** is a local-only Node.js/TypeScript debugging/tracing library built on OpenTelemetry. It is a library, not a standalone application — there is no dev server to start.

### Quick reference

| Action | Command |
|---|---|
| Install deps | `npm ci` |
| Type check | `npm run build` (`tsc --noEmit`) |
| Run tests | `npm test` (`vitest run`) |
| Watch tests | `npm run test:watch` |

### Notes

- **Node.js 22** is required (matches CI and `@types/node` version).
- Tests use **Vitest** with `pool: 'forks'` for OTel global provider isolation. Each test file runs in its own forked process — this is intentional, not a misconfiguration.
- `npm run build` only type-checks (`tsc --noEmit`); there is no compiled output. Vitest handles TS transpilation internally.
- The embedded Express HTTP API (port 43210) auto-starts when `instrumentation.node.ts` is imported. Tests that exercise HTTP endpoints start/stop this server within the test process — no manual server startup needed.
- The `punycode` deprecation warning from Node.js 22 is benign and comes from an OpenTelemetry transitive dependency; it does not affect functionality.
- No Docker, databases, or external services are required.
