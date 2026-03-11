# AGENTS.md

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

---

## Cursor Cloud Agents

Cursor Cloud sandboxes do **not** use `systemd`, so Docker must be started manually.

### Docker setup

```bash
DOCKER_IPTABLES=false bash scripts/start-docker.sh
export DOCKER_HOST=unix:///tmp/docker.sock
```

**Important:** Cursor Cloud requires `--iptables=false` and `--ip6tables=false`. The script respects `DOCKER_IPTABLES=false` for this. With iptables disabled, containers cannot pull images from the internet — images must already be cached or pre-pulled.

### Start the stack

```bash
npm run stack:up
```

If the ClickHouse container fails with an rlimit error, use the Cursor Cloud compose override which removes `ulimits`:

```bash
docker compose -f stack/local-otel/compose.yaml -f stack/local-otel/compose.cursor.yaml up -d
```

### Verify

```bash
sudo -E docker ps
curl http://localhost:8123/ping
```

### Cursor Cloud-specific caveats

- socket: `unix:///tmp/docker.sock`
- storage driver: `vfs`
- `--iptables=false` / `--ip6tables=false` (required)
- Do **not** rely on Compose `mem_limit`. Nested cgroup delegation does not expose the memory controller.
- Container `ulimits` may fail — use `compose.cursor.yaml` override if needed.
- After startup, prefix commands with `sudo -E` or use `sg docker`:

  ```bash
  export DOCKER_HOST=unix:///tmp/docker.sock && sudo -E docker ps
  sg docker -c 'export DOCKER_HOST=unix:///tmp/docker.sock && docker ps'
  ```

---

## Claude Code Agents (web)

Claude Code web sandboxes run as root and have internet access, but Docker must also be started manually.

### Docker setup

```bash
bash scripts/start-docker.sh
export DOCKER_HOST=unix:///tmp/docker.sock
```

The script defaults to `--iptables=true`, which allows containers to pull images normally.

### Start the stack

```bash
npm run stack:up
```

### Verify

```bash
docker ps
curl http://localhost:8123/ping
```

### Seed and run the demo

```bash
npm run stack:seed
npm run demo:next:install
npm run demo:next:dev
```

### Claude Code-specific caveats

- `$USER` may be unset — the script handles this automatically.
- Container `ulimits` are not supported (the default compose.yaml omits them).
- iptables is enabled by default so `docker pull` works.
- Running as root means `sudo` is a no-op, which is fine.
