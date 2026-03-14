import { DemoPanel } from '../components/demo-panel';

export default function HomePage() {
  return (
    <main className="page-shell">
      <section className="hero-card">
        <p className="eyebrow">deep-trace demo</p>
        <h1>Next.js frontend + backend telemetry into ClickHouse</h1>
        <p className="lede">
          Click the button to emit a browser span, call a traced Next.js route handler, and then query the
          shared local stack with SQL.
        </p>
      </section>

      <DemoPanel />

      <section className="info-grid">
        <article className="info-card">
          <h2>What gets emitted</h2>
          <ul>
            <li>Browser spans: DemoPanel render, validateInput, buildSearchContext, processResults, mergeAndFormat.</li>
            <li>Two API round trips: /api/analyze (6 server spans) and /api/enrich (5 server spans).</li>
            <li>Full distributed trace with ~20 spans across browser and server, linked via W3C traceparent.</li>
          </ul>
        </article>

        <article className="info-card">
          <h2>Collector endpoint</h2>
          <p>`http://127.0.0.1:4318/v1/traces`</p>
          <p>Configured for both the browser OTLP exporter and the Node-side `deep-trace` runtime.</p>
        </article>

        <article className="info-card">
          <h2>Query endpoint</h2>
          <p>`http://127.0.0.1:8123/?database=otel`</p>
          <p>Use the demo CLI or raw SQL against `otel.otel_traces`.</p>
        </article>
      </section>
    </main>
  );
}
