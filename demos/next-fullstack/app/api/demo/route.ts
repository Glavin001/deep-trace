/**
 * Demo API route — ZERO tracing imports.
 *
 * Tracing is handled automatically:
 * - The exported GET handler is auto-wrapped by the Babel plugin
 * - lookupRecommendation and buildNarrative are auto-wrapped as arrow functions
 * - Server-side OTel SDK is initialized via instrumentation.ts (Next.js framework hook)
 * - Span flushing happens automatically via BatchSpanProcessor
 */

import { NextRequest, NextResponse } from 'next/server';

const lookupRecommendation = async (term: string) => {
  await new Promise(resolve => setTimeout(resolve, 120));

  return {
    confidence: 0.98,
    source: 'mock-model-cache',
    tags: ['frontend', 'backend', 'clickhouse', term.replace(/\s+/g, '-')],
  };
};

const buildNarrative = (term: string, confidence: number) => {
  return `Tracing "${term}" now streams browser and server spans into the local collector with ${Math.round(
    confidence * 100,
  )}% confidence.`;
};

export async function GET(request: NextRequest) {
  const term = request.nextUrl.searchParams.get('term') || 'clickhouse trace search';

  const recommendation = await lookupRecommendation(term);
  const narrative = buildNarrative(term, recommendation.confidence);

  return NextResponse.json({
    term,
    backendService: process.env.OTEL_SERVICE_NAME || 'next-fullstack-api',
    confidence: recommendation.confidence,
    tags: recommendation.tags,
    narrative,
    receivedAt: new Date().toISOString(),
  });
}
