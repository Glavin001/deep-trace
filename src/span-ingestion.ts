/**
 * Span Ingestion — validation, normalization, and batch ingestion
 *
 * Accepts span data from any language via a simple JSON schema,
 * validates required fields, normalizes timestamps, and feeds
 * spans into the SpanCache + JSONL pipeline.
 */

import type { CachedSpan } from './types';

// ─── Client-Facing Input Schema ─────────────────────────────────────────────

export interface IngestSpanInput {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    name: string;
    kind?: string;
    startTime: number | string;
    endTime: number | string;
    duration?: number;
    status?: { code: number; message?: string };
    attributes?: Record<string, any>;
    events?: Array<{ name: string; timestamp: number | string; attributes?: Record<string, any> }>;
    links?: Array<{ traceId: string; spanId: string; attributes?: Record<string, any> }>;
    language?: string;
}

// ─── Validation ──────────────────────────────────────────────────────────────

const HEX_32 = /^[0-9a-f]{32}$/i;
const HEX_16 = /^[0-9a-f]{16}$/i;

export type ValidationResult =
    | { valid: true; span: IngestSpanInput }
    | { valid: false; errors: string[] };

export function validateSpanInput(input: unknown): ValidationResult {
    const errors: string[] = [];

    if (!input || typeof input !== 'object') {
        return { valid: false, errors: ['input must be a non-null object'] };
    }

    const obj = input as Record<string, any>;

    if (typeof obj.traceId !== 'string' || !HEX_32.test(obj.traceId)) {
        errors.push('traceId must be a 32-character hex string');
    }
    if (typeof obj.spanId !== 'string' || !HEX_16.test(obj.spanId)) {
        errors.push('spanId must be a 16-character hex string');
    }
    if (obj.parentSpanId !== undefined && (typeof obj.parentSpanId !== 'string' || !HEX_16.test(obj.parentSpanId))) {
        errors.push('parentSpanId must be a 16-character hex string');
    }
    if (typeof obj.name !== 'string' || obj.name.length === 0) {
        errors.push('name is required and must be a non-empty string');
    }

    if (!isValidTimestamp(obj.startTime)) {
        errors.push('startTime is required (number in microseconds or ISO 8601 string)');
    }
    if (!isValidTimestamp(obj.endTime)) {
        errors.push('endTime is required (number in microseconds or ISO 8601 string)');
    }

    if (errors.length > 0) {
        return { valid: false, errors };
    }

    return { valid: true, span: obj as IngestSpanInput };
}

function isValidTimestamp(value: unknown): boolean {
    if (typeof value === 'number' && value > 0) return true;
    if (typeof value === 'string') {
        const d = new Date(value);
        return !isNaN(d.getTime());
    }
    return false;
}

// ─── Normalization ───────────────────────────────────────────────────────────

function toMicroseconds(value: number | string): number {
    if (typeof value === 'string') {
        return new Date(value).getTime() * 1000;
    }
    return value;
}

export function normalizeSpanInput(input: IngestSpanInput): CachedSpan {
    const startTime = toMicroseconds(input.startTime);
    const endTime = toMicroseconds(input.endTime);
    const duration = input.duration ?? (endTime - startTime);

    const attributes: Record<string, any> = { ...input.attributes };
    attributes['language'] = input.language || attributes['language'] || 'external';
    if (!attributes['function.name']) {
        attributes['function.name'] = input.name;
    }

    return {
        traceId: input.traceId.toLowerCase(),
        spanId: input.spanId.toLowerCase(),
        parentSpanId: input.parentSpanId?.toLowerCase(),
        name: input.name,
        kind: input.kind || 'INTERNAL',
        startTime,
        endTime,
        duration,
        status: input.status || { code: 0 },
        attributes,
        events: (input.events || []).map(e => ({
            name: e.name,
            timestamp: toMicroseconds(e.timestamp),
            attributes: e.attributes || {},
        })),
        links: (input.links || []).map(l => ({
            traceId: l.traceId,
            spanId: l.spanId,
            attributes: l.attributes || {},
        })),
    };
}

// ─── Batch Ingestion ─────────────────────────────────────────────────────────

interface SpanCacheLike {
    addCachedSpan(span: CachedSpan): void;
}

export interface IngestResult {
    accepted: number;
    rejected: Array<{ index: number; errors: string[] }>;
}

export function ingestSpans(
    spanCache: SpanCacheLike,
    inputs: unknown[],
    appendToJsonlFn: (span: CachedSpan) => void,
): IngestResult {
    const result: IngestResult = { accepted: 0, rejected: [] };

    for (let i = 0; i < inputs.length; i++) {
        const validation = validateSpanInput(inputs[i]);
        if (!validation.valid) {
            result.rejected.push({ index: i, errors: validation.errors });
            continue;
        }

        const cached = normalizeSpanInput(validation.span);
        spanCache.addCachedSpan(cached);
        appendToJsonlFn(cached);
        result.accepted++;
    }

    return result;
}
