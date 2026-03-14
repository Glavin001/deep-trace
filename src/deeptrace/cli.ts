#!/usr/bin/env node
/**
 * DeepTrace CLI
 *
 * Usage:
 *   deeptrace run [--tier=1|2|3] [--label="..."] <command...>
 *   deeptrace runs [--limit=N] [--service=S] [--status=success|error]
 *   deeptrace inspect <trace-id>
 *   deeptrace compare <good-trace-id> <bad-trace-id>
 *   deeptrace agent serve [--port=3005]
 *   deeptrace export <trace-id>
 */

import { spawn } from 'child_process';
import * as path from 'path';
import { DeepTraceQueryAPI } from './query-api';
import { startDeepTraceServer } from './server';

// ─── Argument Parsing ────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { command: string; flags: Record<string, string>; rest: string[] } {
  const command = argv[0] || 'help';
  const flags: Record<string, string> = {};
  const rest: string[] = [];

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx >= 0) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        flags[arg.slice(2)] = argv[++i] || 'true';
      }
    } else {
      rest.push(arg);
      // Everything after a non-flag arg is the rest (for 'run' subcommand)
      rest.push(...argv.slice(i + 1));
      break;
    }
  }

  return { command, flags, rest };
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdRun(flags: Record<string, string>, rest: string[]): Promise<void> {
  if (rest.length === 0) {
    console.error('Usage: deeptrace run [--tier=1] [--label="..."] <command...>');
    process.exit(1);
  }

  const tier = flags.tier || '1';
  const label = flags.label || '';

  // Set up environment for the child process
  const env = {
    ...process.env,
    DEEPTRACE_ENABLED: '1',
    DEEPTRACE_TIER: tier,
    DEEPTRACE_LABEL: label,
    DEBUG_PROBE_JSONL: '1',
    DEBUG_PROBE_LOCAL_EXPORTER: '1',
    OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318',
    OTEL_SERVICE_NAME: process.env.OTEL_SERVICE_NAME || 'deeptrace-app',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${path.resolve(__dirname, '..', 'instrumentation.node.js')}`.trim(),
  };

  console.log(`DeepTrace: Starting with tier=${tier}${label ? ` label="${label}"` : ''}`);
  console.log(`DeepTrace: Running: ${rest.join(' ')}`);
  console.log('');

  const child = spawn(rest[0], rest.slice(1), {
    env,
    stdio: 'inherit',
    shell: true,
  });

  child.on('exit', (code) => {
    process.exit(code || 0);
  });
}

async function cmdRuns(flags: Record<string, string>): Promise<void> {
  const api = new DeepTraceQueryAPI();
  try {
    const result = await api.listRuns({
      limit: flags.limit ? Number(flags.limit) : 20,
      service: flags.service,
      status: flags.status as any,
    });

    if (!result.success || !result.data) {
      console.error('Error:', result.error);
      process.exit(1);
    }

    console.log('Recent Trace Runs');
    console.log('─'.repeat(100));
    console.log(
      'Trace ID'.padEnd(35) +
      'Root Span'.padEnd(30) +
      'Service'.padEnd(20) +
      'Duration'.padEnd(12) +
      'Status'.padEnd(10) +
      'Score'
    );
    console.log('─'.repeat(100));

    for (const run of result.data) {
      const status = run.status === 'error' ? '✗ ERROR' : '✓ OK';
      console.log(
        run.traceId.padEnd(35) +
        run.rootSpanName.slice(0, 28).padEnd(30) +
        run.serviceName.slice(0, 18).padEnd(20) +
        `${run.durationMs.toFixed(0)}ms`.padEnd(12) +
        status.padEnd(10) +
        String(run.suspiciousnessScore)
      );
    }

    console.log(`\n${result.data.length} run(s) found`);
  } finally {
    await api.close();
  }
}

async function cmdInspect(traceId: string): Promise<void> {
  const api = new DeepTraceQueryAPI();
  try {
    const result = await api.getTraceSummary(traceId);

    if (!result.success || !result.data) {
      console.error('Error:', result.error);
      process.exit(1);
    }

    const s = result.data;
    console.log(`\nTrace Summary: ${s.traceId}`);
    console.log('═'.repeat(80));
    console.log(`  Root Span:    ${s.rootSpanName}`);
    console.log(`  Services:     ${s.services.join(', ')}`);
    console.log(`  Duration:     ${s.durationMs.toFixed(1)}ms`);
    console.log(`  Span Count:   ${s.spanCount}`);
    console.log(`  Errors:       ${s.errorCount}`);
    console.log(`  Exceptions:   ${s.exceptionCount}`);
    console.log(`  Async Hops:   ${s.asyncHops}`);
    console.log(`  Network Reqs: ${s.networkRequests}`);
    console.log(`  DB Queries:   ${s.dbQueries}`);
    console.log(`  Suspicion:    ${s.suspiciousnessScore}/100`);

    if (s.requestPath.length > 0) {
      console.log(`\nRequest Path:`);
      for (const step of s.requestPath) {
        const status = step.status === 'error' ? ' ✗' : '';
        console.log(`  ${step.index}. ${step.name} (${step.serviceName}) ${step.durationMs.toFixed(1)}ms${status}`);
      }
    }

    if (s.exceptions.length > 0) {
      console.log(`\nExceptions:`);
      for (const exc of s.exceptions) {
        console.log(`  ${exc.type}: ${exc.message}`);
        console.log(`    in ${exc.spanName} (${exc.serviceName})`);
        if (exc.sourceLocation) {
          console.log(`    at ${exc.sourceLocation.filePath}:${exc.sourceLocation.line}`);
        }
      }
    }
  } finally {
    await api.close();
  }
}

async function cmdCompare(goodId: string, badId: string): Promise<void> {
  const api = new DeepTraceQueryAPI();
  try {
    const result = await api.findFirstDivergence(goodId, badId);

    if (!result.success || !result.data) {
      console.error('Error:', result.error);
      process.exit(1);
    }

    const diff = result.data;
    console.log(`\nTrace Comparison`);
    console.log('═'.repeat(80));
    console.log(`  Good: ${diff.goodTraceId}`);
    console.log(`  Bad:  ${diff.badTraceId}`);
    console.log(`\n  ${diff.summary}`);

    if (diff.firstDivergence) {
      console.log(`\nFirst Divergence:`);
      const d = diff.firstDivergence;
      console.log(`  [${d.severity.toUpperCase()}] ${d.description}`);
      if (d.goodValue) console.log(`    Good: ${d.goodValue}`);
      if (d.badValue) console.log(`    Bad:  ${d.badValue}`);
    }

    if (diff.divergences.length > 1) {
      console.log(`\nAll Divergences (${diff.divergences.length}):`);
      for (const d of diff.divergences.slice(0, 10)) {
        console.log(`  [${d.severity}] ${d.description}`);
      }
      if (diff.divergences.length > 10) {
        console.log(`  ... and ${diff.divergences.length - 10} more`);
      }
    }
  } finally {
    await api.close();
  }
}

async function cmdExport(traceId: string): Promise<void> {
  const api = new DeepTraceQueryAPI();
  try {
    const [summaryResult, graphResult] = await Promise.all([
      api.getTraceSummary(traceId, 'visible_to_export'),
      api.getTraceGraph(traceId, { visibility: 'visible_to_export' }),
    ]);

    if (!summaryResult.success || !graphResult.success) {
      console.error('Error:', summaryResult.error || graphResult.error);
      process.exit(1);
    }

    const exportData = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      summary: summaryResult.data,
      graph: graphResult.data,
    };

    console.log(JSON.stringify(exportData, null, 2));
  } finally {
    await api.close();
  }
}

async function cmdAgentServe(flags: Record<string, string>): Promise<void> {
  const port = flags.port ? Number(flags.port) : 3005;
  startDeepTraceServer({ port });
}

function cmdHelp(): void {
  console.log(`
DeepTrace — Runtime Context Debugging Platform

Usage:
  deeptrace run [options] <command...>    Run a command with DeepTrace instrumentation
  deeptrace runs [options]               List recent trace runs
  deeptrace inspect <trace-id>           Inspect a trace
  deeptrace compare <good-id> <bad-id>   Compare two traces, find first divergence
  deeptrace agent serve [--port=3005]    Start the agent/MCP API server
  deeptrace export <trace-id>            Export a trace as JSON

Run Options:
  --tier=1|2|3     Capture tier (default: 1)
  --label="..."    Label for this run

Runs Options:
  --limit=N        Max results (default: 20)
  --service=S      Filter by service
  --status=S       Filter by status (success|error)

Examples:
  deeptrace run npm run dev
  deeptrace run --tier=2 --label="checkout bug" npm run dev
  deeptrace runs --status=error
  deeptrace inspect abc123def456
  deeptrace compare good-trace-id bad-trace-id
`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { command, flags, rest } = parseArgs(process.argv.slice(2));

  switch (command) {
    case 'run':
      await cmdRun(flags, rest);
      break;
    case 'runs':
      await cmdRuns(flags);
      break;
    case 'inspect':
      if (rest.length === 0) {
        console.error('Usage: deeptrace inspect <trace-id>');
        process.exit(1);
      }
      await cmdInspect(rest[0]);
      break;
    case 'compare':
      if (rest.length < 2) {
        console.error('Usage: deeptrace compare <good-trace-id> <bad-trace-id>');
        process.exit(1);
      }
      await cmdCompare(rest[0], rest[1]);
      break;
    case 'export':
      if (rest.length === 0) {
        console.error('Usage: deeptrace export <trace-id>');
        process.exit(1);
      }
      await cmdExport(rest[0]);
      break;
    case 'agent':
      if (rest[0] === 'serve' || flags.serve) {
        await cmdAgentServe(flags);
      } else {
        console.error('Usage: deeptrace agent serve [--port=3005]');
        process.exit(1);
      }
      break;
    case 'help':
    case '--help':
    case '-h':
      cmdHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      cmdHelp();
      process.exit(1);
  }
}

main().catch(err => {
  console.error('DeepTrace error:', err.message);
  process.exit(1);
});
