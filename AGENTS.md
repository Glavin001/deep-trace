# AGENTS.md

## Cursor Cloud / Claude Code specific instructions

**deep-trace** is a local-only Node.js/TypeScript debugging/tracing library built on OpenTelemetry. It is a library, not a standalone application — there is no dev server to start.

### Quick reference

| Action | Command |
|---|---|
| Install deps | `npm ci` |
| Type check | `npm run build` (`tsc --noEmit`) |
| Run tests | `npm test` (`vitest run`) |
| Watch tests | `npm run test:watch` |
| Start Docker (sandbox) | `bash scripts/start-docker.sh` |
| Start stack | `npm run stack:up` |
| Seed sample data | `npm run stack:seed` |
| Stop stack | `npm run stack:down` |
| Run Next.js demo | `npm run demo:next:install && npm run demo:next:dev` |

### Notes

- **Node.js 22** is required (matches CI and `@types/node` version).
- Tests use **Vitest** with `pool: 'forks'` for OTel global provider isolation. Each test file runs in its own forked process — this is intentional, not a misconfiguration.
- `npm run build` only type-checks (`tsc --noEmit`); there is no compiled output. Vitest handles TS transpilation internally.
- The embedded Express HTTP API (port 43210) auto-starts when `instrumentation.node.ts` is imported. Tests that exercise HTTP endpoints start/stop this server within the test process — no manual server startup needed.
- The `punycode` deprecation warning from Node.js 22 is benign and comes from an OpenTelemetry transitive dependency; it does not affect functionality.
- Docker is optional for the library tests, but required for the local collector/ClickHouse stack and demos.

### Docker in sandbox environments

Sandbox environments (Cursor Cloud, Claude Code on the web, CI) often do **not** use `systemd`, so Docker must be started manually.

1. Install and start Docker:

   ```bash
   bash scripts/start-docker.sh
   export DOCKER_HOST=unix:///tmp/docker.sock
   ```

2. Verify Docker is working:

   ```bash
   docker ps
   ```

3. Start the stack:

   ```bash
   npm run stack:up
   ```

#### Sandbox-specific notes

- The `start-docker.sh` script defaults to `--iptables=true` so containers can pull images. If your sandbox blocks iptables, set `DOCKER_IPTABLES=false` before running the script — but note that containers will not be able to reach the internet (you must pre-pull images).
- The script uses `vfs` as the storage driver, which works in nested/unprivileged environments but uses more disk space.
- After startup, all `docker` and `docker compose` commands must use the custom socket:

  ```bash
  export DOCKER_HOST=unix:///tmp/docker.sock
  docker compose -f stack/local-otel/compose.yaml up -d
  ```

- Do **not** rely on Compose `mem_limit` or container `ulimits` in sandboxes. Nested cgroup delegation may not expose the memory controller, and rlimit changes may be denied.
