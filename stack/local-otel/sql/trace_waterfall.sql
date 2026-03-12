SELECT
    TraceId,
    SpanId,
    ParentSpanId,
    SpanName,
    ServiceName,
    SpanKind,
    Duration / 1000000 AS duration_ms,
    StatusCode,
    Timestamp,
    SpanAttributes
FROM otel.otel_traces
WHERE TraceId = '{trace_id}'
ORDER BY Timestamp ASC;
