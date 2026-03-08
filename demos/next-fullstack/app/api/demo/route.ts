import { SpanStatusCode, trace } from '@opentelemetry/api';
import { NextRequest, NextResponse } from 'next/server';
import { flushSpans, wrapUserFunction } from '../../../../../src/instrumentation.node';

const lookupRecommendation = wrapUserFunction(async function lookupRecommendation(term: string) {
  await new Promise(resolve => setTimeout(resolve, 120));

  return {
    confidence: 0.98,
    source: 'mock-model-cache',
    tags: ['frontend', 'backend', 'clickhouse', term.replace(/\s+/g, '-')],
  };
}, 'demo.lookupRecommendation');

const buildNarrative = wrapUserFunction(function buildNarrative(term: string, confidence: number) {
  return `Tracing "${term}" now streams browser and server spans into the local collector with ${Math.round(
    confidence * 100,
  )}% confidence.`;
}, 'demo.buildNarrative');

export async function GET(request: NextRequest) {
  const tracer = trace.getTracer('next-fullstack-api');

  return tracer.startActiveSpan('demo.api.handle_recommendation', async (span) => {
    try {
      const term = request.nextUrl.searchParams.get('term') || 'clickhouse trace search';
      const source = request.headers.get('x-demo-source') || 'unknown';

      span.setAttribute('demo.term', term);
      span.setAttribute('demo.request.source', source);

      const recommendation = await lookupRecommendation(term);
      const narrative = buildNarrative(term, recommendation.confidence);

      span.addEvent('demo.response.ready');
      span.setStatus({ code: SpanStatusCode.OK });

      return NextResponse.json({
        term,
        traceId: span.spanContext().traceId,
        backendService: process.env.OTEL_SERVICE_NAME || 'next-fullstack-api',
        confidence: recommendation.confidence,
        tags: recommendation.tags,
        narrative,
        receivedAt: new Date().toISOString(),
      });
    } catch (caughtError) {
      span.recordException(caughtError as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: caughtError instanceof Error ? caughtError.message : String(caughtError),
      });

      return NextResponse.json(
        {
          error: caughtError instanceof Error ? caughtError.message : String(caughtError),
        },
        { status: 500 },
      );
    } finally {
      span.end();
      await flushSpans().catch(() => {});
    }
  });
}
