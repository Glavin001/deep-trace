const preset = process.argv[2] || 'recent';
const endpoint = process.env.CLICKHOUSE_URL || 'http://127.0.0.1:8123/';
const clickhouseUser = process.env.CLICKHOUSE_USER || 'otel';
const clickhousePassword = process.env.CLICKHOUSE_PASSWORD || 'otel';
const traceId = process.env.TRACE_ID;

const statements = {
  recent: `
    SELECT
      TraceId,
      SpanName,
      ServiceName,
      Duration / 1000000 AS duration_ms,
      Timestamp
    FROM otel.otel_traces
    ORDER BY Timestamp DESC
    LIMIT 20
  `,
  services: `
    SELECT DISTINCT ServiceName
    FROM otel.otel_traces
    WHERE Timestamp >= now() - INTERVAL 1 HOUR
    ORDER BY ServiceName
  `,
  trace: traceId
    ? `
        SELECT
          TraceId,
          SpanId,
          ParentSpanId,
          SpanName,
          ServiceName,
          Duration / 1000000 AS duration_ms,
          Timestamp
        FROM otel.otel_traces
        WHERE TraceId = '${traceId}'
        ORDER BY Timestamp ASC
      `
    : null,
};

if (!statements[preset]) {
  throw new Error(`Unknown preset "${preset}". Use recent, services, or trace with TRACE_ID=...`);
}

const url = new URL(endpoint);
url.searchParams.set('database', 'otel');

const response = await fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'text/plain',
    authorization: `Basic ${Buffer.from(`${clickhouseUser}:${clickhousePassword}`).toString('base64')}`,
  },
  body: `${statements[preset]} FORMAT JSON`,
});

if (!response.ok) {
  throw new Error(`Query failed: ${response.status} ${await response.text()}`);
}

const payload = await response.json();
console.log(JSON.stringify(payload.data, null, 2));
