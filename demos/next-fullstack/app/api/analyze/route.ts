/**
 * /api/analyze — Rich analysis API route. ZERO tracing imports.
 *
 * Tracing is handled automatically:
 * - The exported GET handler is auto-wrapped by the Babel plugin
 * - All inner arrow functions are auto-wrapped
 * - Server-side OTel SDK is initialized via instrumentation.ts
 *
 * Produces multiple child spans:
 *   GET → parseSearchParams → classifyIntent → lookupRecommendations
 *       → scoreResults → buildNarrative
 */

import { NextRequest, NextResponse } from 'next/server';

// ── Helper functions (each becomes a traced span) ────────────────────────

const parseSearchParams = (request: NextRequest) => {
  const term = request.nextUrl.searchParams.get('term') || 'clickhouse trace search';
  const sessionId = request.nextUrl.searchParams.get('session') || 'unknown';
  const normalized = term.toLowerCase().trim();
  const tokens = normalized.split(/\s+/);
  return { term, sessionId, normalized, tokens, tokenCount: tokens.length };
};

const classifyIntent = async (tokens: string[], tokenCount: number) => {
  // Simulate ML classification with async delay
  await new Promise(resolve => setTimeout(resolve, 15));
  const categories: Record<string, string[]> = {
    search: ['search', 'find', 'query', 'lookup', 'get'],
    analytics: ['trace', 'monitor', 'metrics', 'dashboard', 'observe'],
    infrastructure: ['clickhouse', 'database', 'server', 'deploy', 'scale'],
    development: ['code', 'build', 'test', 'debug', 'frontend', 'backend'],
  };
  let bestCategory = 'general';
  let bestScore = 0;
  for (const [category, keywords] of Object.entries(categories)) {
    const matches = tokens.filter(t => keywords.some(k => t.includes(k))).length;
    const score = matches / Math.max(tokenCount, 1);
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }
  return {
    category: bestCategory,
    confidence: Math.min(bestScore + 0.4, 0.99),
    matchedTokens: tokens.filter(t =>
      Object.values(categories).flat().some(k => t.includes(k)),
    ),
  };
};

const lookupRecommendations = async (term: string, intent: string) => {
  // Simulate database/cache lookup
  await new Promise(resolve => setTimeout(resolve, 80));
  const mockRecommendations = [
    { label: `${intent}-overview`, score: 0.95, source: 'knowledge-base' },
    { label: `${term.split(' ')[0]}-guide`, score: 0.88, source: 'docs-index' },
    { label: `getting-started-${intent}`, score: 0.82, source: 'tutorials' },
    { label: `${intent}-best-practices`, score: 0.76, source: 'community' },
    { label: `advanced-${term.split(' ').pop()}`, score: 0.71, source: 'deep-dives' },
    { label: `troubleshoot-${intent}`, score: 0.65, source: 'support-kb' },
  ];
  return mockRecommendations;
};

const scoreResults = (recommendations: Array<{ label: string; score: number; source: string }>, confidence: number) => {
  // Re-score based on intent confidence
  const adjusted = recommendations.map(rec => ({
    ...rec,
    score: Math.round(rec.score * (0.5 + confidence * 0.5) * 100) / 100,
  }));
  adjusted.sort((a, b) => b.score - a.score);
  const topScore = adjusted[0]?.score || 0;
  const avgScore = adjusted.reduce((sum, r) => sum + r.score, 0) / adjusted.length;
  return { scored: adjusted, topScore, avgScore: Math.round(avgScore * 100) / 100 };
};

const buildNarrative = (term: string, intent: string, confidence: number, topScore: number) => {
  return `Analysis of "${term}" classified as ${intent} intent (${Math.round(confidence * 100)}% confidence). ` +
    `Top recommendation scores ${Math.round(topScore * 100)}%. ` +
    `Browser and server spans flow into the local collector for full-stack observability.`;
};

// ── Route handler ────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const params = parseSearchParams(request);
  const intent = await classifyIntent(params.tokens, params.tokenCount);
  const recommendations = await lookupRecommendations(params.term, intent.category);
  const { scored, topScore } = scoreResults(recommendations, intent.confidence);
  const narrative = buildNarrative(params.term, intent.category, intent.confidence, topScore);
  const tags = [intent.category, ...intent.matchedTokens, params.term.replace(/\s+/g, '-')];

  return NextResponse.json({
    term: params.term,
    backendService: process.env.OTEL_SERVICE_NAME || 'next-fullstack-api',
    intent: { category: intent.category, confidence: intent.confidence },
    recommendations: scored,
    narrative,
    tags,
    receivedAt: new Date().toISOString(),
  });
}
