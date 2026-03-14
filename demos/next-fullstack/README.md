# Next.js full-stack demo

This demo sends both browser and server spans into the shared local collector stack.

## Run

1. Start the stack:

   ```bash
   npm run stack:up
   ```

2. Install demo dependencies:

   ```bash
   npm run demo:next:install
   ```

3. Start the app (env vars are set in `package.json` scripts):

   ```bash
   npm run demo:next:dev
   ```

4. Open `http://127.0.0.1:3000`, click the button, then query ClickHouse.
5. Open `http://127.0.0.1:3002/explore` to inspect the same trace in Grafana's waterfall view with the provisioned `ClickHouse Traces` datasource.

## Query

```bash
npm run query:recent --prefix demos/next-fullstack
npm run query:services --prefix demos/next-fullstack
TRACE_ID=<trace-id> npm run query:trace --prefix demos/next-fullstack
```

The query scripts default to `CLICKHOUSE_USER=otel` and `CLICKHOUSE_PASSWORD=otel`.

## What to look for

- `next-fullstack-web` spans from the browser.
- `next-fullstack-api` spans from the Next.js server.
- `demo.lookupRecommendation` and `demo.buildNarrative` spans with `function.*` attributes from the enhanced library.
