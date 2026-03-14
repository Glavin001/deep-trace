'use client';

import { useMemo, useState } from 'react';

/**
 * Demo panel component — ZERO tracing imports.
 *
 * Tracing is handled automatically:
 * - This component is auto-wrapped by the Babel plugin (PascalCase → isComponent: true)
 * - All inner arrow functions are auto-wrapped by the Babel plugin
 * - fetch() calls auto-inject traceparent headers (via browser-init.ts fetch patch)
 * - No manual span creation, no manual header injection needed
 *
 * The flow produces a rich trace:
 *   DemoPanel (render)
 *     └─ runDemo (click)
 *          ├─ validateInput
 *          ├─ buildSearchContext
 *          ├─ fetch /api/analyze  →  server spans
 *          ├─ processAnalysisResults
 *          ├─ fetch /api/enrich   →  server spans
 *          └─ mergeAndFormat
 */

interface AnalyzeResponse {
  term: string;
  traceId?: string;
  backendService: string;
  intent: { category: string; confidence: number };
  recommendations: Array<{ label: string; score: number; source: string }>;
  narrative: string;
  tags: string[];
  receivedAt: string;
}

interface EnrichResponse {
  relatedTerms: string[];
  timeline: Array<{ event: string; timestamp: string; durationMs: number }>;
  summary: string;
}

interface CombinedResult {
  analysis: AnalyzeResponse;
  enrichment: EnrichResponse;
  displayScore: number;
  formattedTags: string;
}

const defaultTerm = 'clickhouse trace search';

export function DemoPanel() {
  const [term, setTerm] = useState(defaultTerm);
  const [result, setResult] = useState<CombinedResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const queryHint = useMemo(() => {
    if (!result?.analysis.traceId) return 'Run the demo to get a trace id.';
    return `TRACE_ID=${result.analysis.traceId} npm run query:trace`;
  }, [result?.analysis.traceId]);

  // ── Frontend traced functions ──────────────────────────────────────────

  const validateInput = (input: string) => {
    const trimmed = input.trim();
    if (trimmed.length === 0) throw new Error('Search term cannot be empty');
    if (trimmed.length > 200) throw new Error('Search term too long (max 200 chars)');
    const sanitized = trimmed.replace(/[<>"'&]/g, '');
    return { original: input, sanitized, charCount: sanitized.length, wordCount: sanitized.split(/\s+/).length };
  };

  const buildSearchContext = (validated: { sanitized: string; wordCount: number }) => {
    const sessionId = Math.random().toString(36).slice(2, 10);
    const timestamp = new Date().toISOString();
    const browserInfo = {
      userAgent: navigator.userAgent.slice(0, 80),
      language: navigator.language,
      screenWidth: window.innerWidth,
      online: navigator.onLine,
    };
    return {
      query: validated.sanitized,
      wordCount: validated.wordCount,
      sessionId,
      timestamp,
      browser: browserInfo,
      locale: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  };

  const processAnalysisResults = (response: AnalyzeResponse) => {
    const topRecommendations = response.recommendations
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    const avgScore = topRecommendations.reduce((sum, r) => sum + r.score, 0) / topRecommendations.length;
    const qualityTier = avgScore > 0.8 ? 'high' : avgScore > 0.5 ? 'medium' : 'low';
    return {
      topRecommendations,
      avgScore: Math.round(avgScore * 100) / 100,
      qualityTier,
      tagSummary: response.tags.join(', '),
      intentMatch: response.intent.confidence > 0.7,
    };
  };

  const mergeAndFormat = (
    analysis: AnalyzeResponse,
    enrichment: EnrichResponse,
    processed: ReturnType<typeof processAnalysisResults>,
  ) => {
    const displayScore = Math.round(
      (analysis.intent.confidence * 0.4 + processed.avgScore * 0.6) * 100,
    );
    const formattedTags = [
      ...analysis.tags,
      ...enrichment.relatedTerms.slice(0, 3),
    ]
      .filter((tag, i, arr) => arr.indexOf(tag) === i)
      .join(' · ');
    return { analysis, enrichment, displayScore, formattedTags };
  };

  // ── Main demo flow ─────────────────────────────────────────────────────

  const runDemo = async () => {
    setLoading(true);
    setError(null);

    try {
      // Step 1: Validate and prepare
      const validated = validateInput(term);
      const searchContext = buildSearchContext(validated);

      // Step 2: First API call — analyze the term
      const analyzeResponse = await fetch(
        `/api/analyze?term=${encodeURIComponent(searchContext.query)}&session=${searchContext.sessionId}`,
        { cache: 'no-store', headers: { 'x-demo-source': 'browser-button' } },
      );
      if (!analyzeResponse.ok) throw new Error(`Analyze request failed: ${analyzeResponse.status}`);
      const analysis = (await analyzeResponse.json()) as AnalyzeResponse;

      // Step 3: Process the analysis results on the frontend
      const processed = processAnalysisResults(analysis);

      // Step 4: Second API call — enrich with related data
      const enrichResponse = await fetch('/api/enrich', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'x-demo-source': 'browser-button' },
        body: JSON.stringify({
          term: analysis.term,
          tags: analysis.tags,
          intent: analysis.intent.category,
          topScore: processed.avgScore,
        }),
      });
      if (!enrichResponse.ok) throw new Error(`Enrich request failed: ${enrichResponse.status}`);
      const enrichment = (await enrichResponse.json()) as EnrichResponse;

      // Step 5: Merge everything together on the frontend
      const combined = mergeAndFormat(analysis, enrichment, processed);
      setResult(combined);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
    } finally {
      setLoading(false);
    }
  };

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
        The browser creates spans, makes two API calls (analyze + enrich), processes results,
        then merges everything — all traced automatically across browser and server.
      </p>

      <div className="result-grid">
        <article className="result-card">
          <h3>Status</h3>
          <div className="status-pill">{result ? 'Trace stored' : 'Waiting for run'}</div>
        </article>

        <article className="result-card">
          <h3>Trace id</h3>
          <code>{result?.analysis.traceId || 'No trace yet'}</code>
        </article>

        <article className="result-card">
          <h3>Quality score</h3>
          <code>{result ? `${result.displayScore}%` : '—'}</code>
        </article>

        <article className="result-card">
          <h3>Query hint</h3>
          <code>{queryHint}</code>
        </article>
      </div>

      {result ? (
        <>
          <div className="result-grid" style={{ marginTop: 16 }}>
            <article className="result-card">
              <h3>Narrative</h3>
              <p>{result.analysis.narrative}</p>
            </article>

            <article className="result-card">
              <h3>Intent</h3>
              <p>
                {result.analysis.intent.category} ({Math.round(result.analysis.intent.confidence * 100)}%)
              </p>
            </article>

            <article className="result-card">
              <h3>Tags</h3>
              <p>{result.formattedTags}</p>
            </article>

            <article className="result-card">
              <h3>Enrichment</h3>
              <p>{result.enrichment.summary}</p>
            </article>
          </div>

          <div className="result-grid" style={{ marginTop: 16 }}>
            <article className="result-card" style={{ gridColumn: '1 / -1' }}>
              <h3>Top recommendations</h3>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                {result.analysis.recommendations.slice(0, 5).map((rec) => (
                  <span key={rec.label} className="status-pill">
                    {rec.label} ({Math.round(rec.score * 100)}%)
                  </span>
                ))}
              </div>
            </article>
          </div>
        </>
      ) : null}

      {error ? <div className="error-card">{error}</div> : null}
    </section>
  );
}
