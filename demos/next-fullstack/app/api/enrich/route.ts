/**
 * /api/enrich — Enrichment API route. ZERO tracing imports.
 *
 * Second API call in the demo flow. Takes analysis results and enriches
 * them with related terms, a timeline, and a summary.
 *
 * Produces multiple child spans:
 *   POST → validatePayload → lookupRelatedTerms → generateTimeline
 *        → formatEnrichment
 */

import { NextRequest, NextResponse } from 'next/server';

// ── Helper functions (each becomes a traced span) ────────────────────────

const validatePayload = (body: any) => {
  if (!body || typeof body !== 'object') throw new Error('Invalid payload');
  const term = String(body.term || '');
  const tags = Array.isArray(body.tags) ? body.tags.map(String) : [];
  const intent = String(body.intent || 'general');
  const topScore = Number(body.topScore) || 0;
  return { term, tags, intent, topScore, valid: term.length > 0 };
};

const lookupRelatedTerms = async (term: string, tags: string[]) => {
  // Simulate a search for related terms
  await new Promise(resolve => setTimeout(resolve, 40));
  const words = term.split(/\s+/);
  const related = [
    ...words.map(w => `${w}-patterns`),
    ...tags.slice(0, 3).map(t => `${t}-ecosystem`),
    `${words[0]}-alternatives`,
    'observability-stack',
  ];
  return related.slice(0, 8);
};

const generateTimeline = async (term: string, intent: string) => {
  // Simulate building an activity timeline
  await new Promise(resolve => setTimeout(resolve, 25));
  const now = Date.now();
  const events = [
    { event: `${intent} query received`, timestamp: new Date(now - 200).toISOString(), durationMs: 5 },
    { event: 'intent classification', timestamp: new Date(now - 180).toISOString(), durationMs: 15 },
    { event: 'recommendation lookup', timestamp: new Date(now - 100).toISOString(), durationMs: 80 },
    { event: 'scoring pipeline', timestamp: new Date(now - 20).toISOString(), durationMs: 10 },
    { event: 'enrichment complete', timestamp: new Date(now).toISOString(), durationMs: 3 },
  ];
  return events;
};

const formatEnrichment = (
  relatedTerms: string[],
  timeline: Array<{ event: string; timestamp: string; durationMs: number }>,
  topScore: number,
) => {
  const totalDuration = timeline.reduce((sum, e) => sum + e.durationMs, 0);
  const summary = `Enriched with ${relatedTerms.length} related terms across ${timeline.length} pipeline stages ` +
    `(${totalDuration}ms total). Quality score: ${Math.round(topScore * 100)}%.`;
  return { relatedTerms, timeline, summary };
};

// ── Route handler ────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const body = await request.json();
  const payload = validatePayload(body);
  const relatedTerms = await lookupRelatedTerms(payload.term, payload.tags);
  const timeline = await generateTimeline(payload.term, payload.intent);
  const enrichment = formatEnrichment(relatedTerms, timeline, payload.topScore);

  return NextResponse.json(enrichment);
}
