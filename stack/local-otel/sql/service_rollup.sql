SELECT
    ServiceName,
    count() AS total_spans,
    countIf(StatusCode = 'STATUS_CODE_ERROR') AS error_spans,
    round(error_spans / total_spans * 100, 2) AS error_rate_pct,
    quantile(0.99)(Duration / 1000000) AS p99_duration_ms
FROM otel.otel_traces
WHERE Timestamp >= now() - INTERVAL 1 HOUR
GROUP BY ServiceName
ORDER BY p99_duration_ms DESC
