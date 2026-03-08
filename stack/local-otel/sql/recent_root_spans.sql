SELECT
    TraceId,
    SpanName,
    ServiceName,
    Duration / 1000000 AS duration_ms,
    StatusCode,
    Timestamp
FROM otel.otel_traces
WHERE ParentSpanId = ''
ORDER BY Timestamp DESC
LIMIT 25;
