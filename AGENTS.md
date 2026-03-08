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
| Start Docker in Cursor Cloud | `bash scripts/start-docker.sh` |

### Notes

- **Node.js 22** is required (matches CI and `@types/node` version).
- Tests use **Vitest** with `pool: 'forks'` for OTel global provider isolation. Each test file runs in its own forked process — this is intentional, not a misconfiguration.
- `npm run build` only type-checks (`tsc --noEmit`); there is no compiled output. Vitest handles TS transpilation internally.
- The embedded Express HTTP API (port 43210) auto-starts when `instrumentation.node.ts` is imported. Tests that exercise HTTP endpoints start/stop this server within the test process — no manual server startup needed.
- The `punycode` deprecation warning from Node.js 22 is benign and comes from an OpenTelemetry transitive dependency; it does not affect functionality.
- Docker is optional for the library tests, but required for the local collector/ClickHouse stack and demos.

### Docker in Cursor Cloud

- Cursor Cloud sandboxes here do **not** use `systemd`, so Docker must be started manually.
- Install and start Docker with:

  ```bash
  bash scripts/start-docker.sh
  ```

- The working daemon settings in this sandbox are:
  - socket: `unix:///tmp/docker.sock`
  - storage driver: `vfs`
  - `--iptables=false`
  - `--ip6tables=false`
- After startup, use one of:

  ```bash
  export DOCKER_HOST=unix:///tmp/docker.sock && sudo -E docker ps
  sg docker -c 'export DOCKER_HOST=unix:///tmp/docker.sock && docker ps'
  ```

- `docker compose` works through the same socket:

  ```bash
  export DOCKER_HOST=unix:///tmp/docker.sock && sudo -E docker compose version
  export DOCKER_HOST=unix:///tmp/docker.sock && sudo -E docker compose -f stack/local-otel/compose.yaml up -d
  ```

- Do **not** rely on Compose `mem_limit` in this sandbox. Nested cgroup delegation here does not expose the memory controller, so container-level memory limits fail even though Docker itself works.
