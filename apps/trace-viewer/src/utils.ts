/**
 * Parse a timestamp string from ClickHouse.
 * ClickHouse DateTime64 returns "2026-03-14 10:27:31.123456789" (UTC, no Z suffix).
 * new Date() would treat that as local time, so we append 'Z' to force UTC.
 */
export function parseTimestamp(ts: string): number {
  if (!ts) return 0;
  if (!ts.endsWith('Z') && !ts.includes('+') && !ts.includes('T')) {
    return new Date(ts.replace(' ', 'T') + 'Z').getTime();
  }
  return new Date(ts).getTime();
}
