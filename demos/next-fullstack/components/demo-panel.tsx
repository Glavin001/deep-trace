'use client';

import { useEffect, useMemo, useState } from 'react';
import { injectTraceHeaders, initBrowserTelemetry, withBrowserSpan } from '../lib/browser-telemetry';

interface DemoResponse {
  term: string;
  traceId: string;
  backendService: string;
  narrative: string;
  confidence: number;
  tags: string[];
  receivedAt: string;
}

const defaultTerm = 'clickhouse trace search';

export function DemoPanel() {
  const [term, setTerm] = useState(defaultTerm);
  const [result, setResult] = useState<DemoResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    initBrowserTelemetry();
  }, []);

  const queryHint = useMemo(() => {
    if (!result?.traceId) return 'Run the demo to get a trace id.';
    return `TRACE_ID=${result.traceId} npm run query:trace`;
  }, [result?.traceId]);

  async function runDemo() {
    setLoading(true);
    setError(null);

    try {
      const payload = await withBrowserSpan(
        'demo.ui.run_query',
        {
          'demo.surface': 'next-fullstack',
          'demo.term': term,
        },
        async (span) => {
          span.addEvent('ui.button.clicked');

          const response = await fetch(`/api/demo?term=${encodeURIComponent(term)}`, {
            cache: 'no-store',
            headers: injectTraceHeaders({
              'x-demo-source': 'browser-button',
            }),
          });

          span.setAttribute('http.response.status_code', response.status);
          if (!response.ok) {
            throw new Error(`Demo request failed with ${response.status}`);
          }

          const body = (await response.json()) as DemoResponse;
          span.setAttribute('demo.backend.trace_id', body.traceId);
          span.addEvent('ui.response.received');
          return body;
        },
      );

      setResult(payload);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="panel-card">
      <div className="controls">
        <input
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Describe the request you want to trace"
        />
        <button type="button" onClick={runDemo} disabled={loading}>
          {loading ? 'Sending spans...' : 'Emit frontend + backend trace'}
        </button>
      </div>

      <p className="muted">
        The browser creates a span first, injects `traceparent`, then calls the traced API route.
      </p>

      <div className="result-grid">
        <article className="result-card">
          <h3>Status</h3>
          <div className="status-pill">{result ? 'Trace stored' : 'Waiting for run'}</div>
        </article>

        <article className="result-card">
          <h3>Trace id</h3>
          <code>{result?.traceId || 'No trace yet'}</code>
        </article>

        <article className="result-card">
          <h3>Backend service</h3>
          <code>{result?.backendService || 'next-fullstack-api'}</code>
        </article>

        <article className="result-card">
          <h3>Query hint</h3>
          <code>{queryHint}</code>
        </article>
      </div>

      {result ? (
        <div className="result-grid" style={{ marginTop: 16 }}>
          <article className="result-card">
            <h3>Response narrative</h3>
            <p>{result.narrative}</p>
          </article>

          <article className="result-card">
            <h3>Confidence</h3>
            <p>{Math.round(result.confidence * 100)}%</p>
          </article>

          <article className="result-card">
            <h3>Tags</h3>
            <p>{result.tags.join(', ')}</p>
          </article>

          <article className="result-card">
            <h3>Received at</h3>
            <p>{new Date(result.receivedAt).toLocaleTimeString()}</p>
          </article>
        </div>
      ) : null}

      {error ? <div className="error-card">{error}</div> : null}
    </section>
  );
}
