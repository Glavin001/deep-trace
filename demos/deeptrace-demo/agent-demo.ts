/**
 * DeepTrace Agent Demo
 *
 * Demonstrates using the MCP-compatible agent tool interface
 * to investigate traces programmatically.
 *
 * Usage: npx tsx agent-demo.ts [good-trace-id] [bad-trace-id]
 */

import { createClient } from '@clickhouse/client';

const BASE_URL = process.env.DEEPTRACE_URL || 'http://127.0.0.1:3004';

async function fetchJSON(path: string): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function agentCall(tool: string, args: Record<string, any>): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/agent/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, args }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

function printSection(title: string) {
  console.log('');
  console.log(`${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'─'.repeat(60)}`);
}

async function main() {
  const goodTraceId = process.argv[2];
  const badTraceId = process.argv[3];

  console.log('DeepTrace Agent Demo');
  console.log('====================');
  console.log('');
  console.log('This demo shows how an AI agent can use the DeepTrace tool');
  console.log('interface to investigate traces and find root causes.');

  // Step 1: List recent runs
  printSection('Step 1: list_runs — Find recent traces');
  const runsResult = await fetchJSON('/api/dt/runs?limit=10');
  if (runsResult.success && runsResult.data) {
    console.log(`Found ${runsResult.data.length} recent run(s):`);
    for (const run of runsResult.data.slice(0, 5)) {
      const status = run.status === 'error' ? 'ERROR' : 'OK';
      console.log(`  [${status}] ${run.rootSpanName} (${run.traceId.slice(0, 16)}...) ${run.durationMs.toFixed(0)}ms`);
    }
  }

  // If specific trace IDs were provided, use those
  let targetGood = goodTraceId;
  let targetBad = badTraceId;

  if (!targetGood || !targetBad) {
    console.log('\nNo specific trace IDs provided. Using most recent traces.');
    if (runsResult.success && runsResult.data) {
      const errorRun = runsResult.data.find((r: any) => r.status === 'error');
      const okRun = runsResult.data.find((r: any) => r.status === 'success');
      targetGood = okRun?.traceId;
      targetBad = errorRun?.traceId;
    }
  }

  if (!targetGood && !targetBad) {
    console.log('\nNo traces found. Run the demo first: npx tsx demo.ts');
    return;
  }

  // Step 2: Get trace summary for bad trace
  if (targetBad) {
    printSection('Step 2: get_trace_summary — What happened in the bad trace?');
    const summary = await fetchJSON(`/api/dt/traces/${targetBad}/summary`);
    if (summary.success && summary.data) {
      const s = summary.data;
      console.log(`  Root Span:   ${s.rootSpanName}`);
      console.log(`  Services:    ${s.services.join(', ')}`);
      console.log(`  Duration:    ${s.durationMs.toFixed(1)}ms`);
      console.log(`  Spans:       ${s.spanCount}`);
      console.log(`  Errors:      ${s.errorCount}`);
      console.log(`  Exceptions:  ${s.exceptionCount}`);
      console.log(`  Suspicion:   ${s.suspiciousnessScore}/100`);

      if (s.exceptions.length > 0) {
        console.log(`\n  Exceptions found:`);
        for (const exc of s.exceptions) {
          console.log(`    ${exc.type}: ${exc.message}`);
          console.log(`      in ${exc.spanName} (${exc.serviceName})`);
          if (exc.sourceLocation) {
            console.log(`      at ${exc.sourceLocation.filePath}:${exc.sourceLocation.line}`);
          }
        }
      }

      if (s.requestPath.length > 0) {
        console.log(`\n  Request path:`);
        for (const step of s.requestPath) {
          const marker = step.status === 'error' ? ' ← ERROR' : '';
          console.log(`    ${step.index + 1}. ${step.name} (${step.serviceName}) ${step.durationMs.toFixed(0)}ms${marker}`);
        }
      }
    }
  }

  // Step 3: Find exceptions
  if (targetBad) {
    printSection('Step 3: find_exceptions — Get exception details');
    const excResult = await fetchJSON(`/api/dt/traces/${targetBad}/summary`);
    if (excResult.success && excResult.data?.exceptions) {
      for (const exc of excResult.data.exceptions) {
        console.log(`  ${exc.type}: ${exc.message}`);
        console.log(`    Span: ${exc.spanName}`);
        console.log(`    Service: ${exc.serviceName}`);
        if (exc.sourceLocation) {
          console.log(`    File: ${exc.sourceLocation.filePath}:${exc.sourceLocation.line}`);
        }
      }
    }
  }

  // Step 4: Get execution graph
  if (targetBad) {
    printSection('Step 4: get_trace_graph — Causal execution graph');
    const graphResult = await fetchJSON(`/api/dt/traces/${targetBad}/graph`);
    if (graphResult.success && graphResult.data) {
      const g = graphResult.data;
      console.log(`  Nodes: ${g.nodes.length}`);
      console.log(`  Edges: ${g.edges.length}`);
      console.log('');
      console.log('  Node types:');
      const typeCounts: Record<string, number> = {};
      for (const n of g.nodes) {
        typeCounts[n.type] = (typeCounts[n.type] || 0) + 1;
      }
      for (const [type, count] of Object.entries(typeCounts)) {
        console.log(`    ${type}: ${count}`);
      }
      console.log('');
      console.log('  Edge types:');
      const edgeCounts: Record<string, number> = {};
      for (const e of g.edges) {
        edgeCounts[e.type] = (edgeCounts[e.type] || 0) + 1;
      }
      for (const [type, count] of Object.entries(edgeCounts)) {
        console.log(`    ${type}: ${count}`);
      }
    }
  }

  // Step 5: Compare good vs bad
  if (targetGood && targetBad) {
    printSection('Step 5: find_first_divergence — Compare good vs bad');
    const diffResult = await fetchJSON(`/api/dt/diff?good=${targetGood}&bad=${targetBad}`);
    if (diffResult.success && diffResult.data) {
      const diff = diffResult.data;
      console.log(`  Summary: ${diff.summary}`);

      if (diff.firstDivergence) {
        console.log(`\n  First Divergence:`);
        console.log(`    [${diff.firstDivergence.severity}] ${diff.firstDivergence.description}`);
        if (diff.firstDivergence.goodValue) console.log(`    Good: ${diff.firstDivergence.goodValue}`);
        if (diff.firstDivergence.badValue) console.log(`    Bad:  ${diff.firstDivergence.badValue}`);
      }

      if (diff.divergences.length > 1) {
        console.log(`\n  All divergences (${diff.divergences.length}):`);
        for (const d of diff.divergences) {
          console.log(`    [${d.severity}] ${d.description}`);
        }
      }
    }
  }

  // Step 6: Summary
  printSection('Agent Investigation Summary');
  console.log('  The agent can now:');
  console.log('    1. Identify the root cause from exception details');
  console.log('    2. Trace the causal chain through the execution graph');
  console.log('    3. See exactly which function, file, and line caused the error');
  console.log('    4. Compare with a working trace to see what diverged');
  console.log('    5. Propose a fix with evidence-backed source references');
  console.log('');
}

main().catch(err => {
  console.error('Agent demo failed:', err.message);
  process.exit(1);
});
