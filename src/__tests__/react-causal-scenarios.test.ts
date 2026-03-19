/**
 * React Causal Debugging Scenario Tests
 *
 * These tests validate that DeepTrace's React causal recording and query tools
 * correctly capture and analyze React-specific debugging scenarios.
 *
 * Scenarios:
 *   R1. useEffect cascade (render → effect → setState → re-render)
 *   R2. Prop drilling re-render storm (unnecessary parent_rerendered)
 *   R3. Async race condition (two fetches write to same state)
 *   R4. Event → state change → re-render chain (full click-to-render causality)
 *   R5. State transitions extraction (Phase 3/4 groundwork)
 */

import { describe, it, expect } from 'vitest';
import {
  buildExecutionGraph,
  buildTraceSummary,
  extractValueSnapshots,
  whyDidRender,
  computeBlastRadius,
  detectEffectCascadeCycles,
  detectAsyncRaceConditions,
  extractStateTransitions,
  getRenderCountsByComponent,
  compareTraces,
  type RawSpan,
} from '../deeptrace/enrichment';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const base = Date.parse('2026-01-15T10:30:00Z');

function makeSpan(overrides: Partial<RawSpan> & { name: string; spanId: string }): RawSpan {
  return {
    traceId: 'trace-react-001',
    parentSpanId: undefined,
    serviceName: 'react-app',
    kind: 'SPAN_KIND_INTERNAL',
    durationMs: 5,
    statusCode: 'STATUS_CODE_OK',
    statusMessage: '',
    timestamp: '2026-01-15 10:30:00.000',
    startTimeMs: base,
    endTimeMs: base + 5,
    attributes: {},
    events: [],
    ...overrides,
  };
}

// ─── Scenario R1: useEffect Cascade ──────────────────────────────────────────
// Component has: useEffect(() => { setDerived(compute(raw)) }, [raw])
// Produces: render → effect fires (dep changed) → setState inside effect → re-render

describe('Scenario R1: useEffect Cascade', () => {
  const spans: RawSpan[] = [
    // Initial render of MyComponent (state_changed: rawValue updated)
    makeSpan({
      spanId: 'render-1',
      name: 'MyComponent',
      durationMs: 3,
      startTimeMs: base,
      endTimeMs: base + 3,
      attributes: {
        'component.name': 'MyComponent',
        'code.function.type': 'react_component',
        'dt.react.render_cause': 'state_changed',
        'dt.react.changed_state_hooks': '[0]',
        'dt.react.state_before': '{"state[0]":"old-value"}',
        'dt.react.state_after': '{"state[0]":"new-value"}',
        'dt.react.commit_id': 'commit_1',
      },
    }),
    // Effect fires because dep [rawValue] changed
    makeSpan({
      spanId: 'effect-1',
      parentSpanId: 'render-1',
      name: 'useEffect [MyComponent#2]',
      durationMs: 2,
      startTimeMs: base + 5,
      endTimeMs: base + 7,
      attributes: {
        'component.name': 'MyComponent',
        'dt.react.effect_type': 'effect',
        'dt.react.effect_hook_index': 2,
        'dt.react.effect_deps_changed': '[0]',
        'dt.react.effect_deps_before': '["old-value"]',
        'dt.react.effect_deps_after': '["new-value"]',
        'dt.react.commit_id': 'commit_1',
      },
    }),
    // setState(derived) called inside the effect
    makeSpan({
      spanId: 'set-state-derived',
      parentSpanId: 'effect-1',
      name: 'setState(derivedValue)',
      durationMs: 1,
      startTimeMs: base + 6,
      endTimeMs: base + 7,
      attributes: {
        'component.name': 'MyComponent',
        'dt.react.set_state_hook_index': 1,
        'dt.react.set_state_caller_span_id': 'effect-1',
        'dt.react.state_before': '"old-derived"',
        'dt.react.state_after': '"new-derived"',
        'dt.react.render_cause': 'state_changed',
        'dt.react.changed_state_hooks': '[1]',
      },
    }),
    // Re-render caused by the setState in the effect
    makeSpan({
      spanId: 'render-2',
      parentSpanId: 'render-1',
      name: 'MyComponent',
      durationMs: 3,
      startTimeMs: base + 10,
      endTimeMs: base + 13,
      attributes: {
        'component.name': 'MyComponent',
        'code.function.type': 'react_component',
        'dt.react.render_cause': 'state_changed',
        'dt.react.changed_state_hooks': '[1]',
        'dt.react.state_before': '{"state[1]":"old-derived"}',
        'dt.react.state_after': '{"state[1]":"new-derived"}',
        'dt.react.set_state_caller_span_id': 'effect-1',
        'dt.react.commit_id': 'commit_2',
      },
    }),
  ];

  it('should classify React causal node types correctly', () => {
    const graph = buildExecutionGraph(spans);

    const render1 = graph.nodes.find(n => n.spanId === 'render-1');
    expect(render1?.type).toBe('react_render');

    const effect1 = graph.nodes.find(n => n.spanId === 'effect-1');
    expect(effect1?.type).toBe('effect_execution');

    const render2 = graph.nodes.find(n => n.spanId === 'render-2');
    expect(render2?.type).toBe('react_render');
  });

  it('should produce dep_changed edge from render to effect', () => {
    const graph = buildExecutionGraph(spans);
    const depChangedEdges = graph.edges.filter(e => e.type === 'dep_changed');
    expect(depChangedEdges.length).toBeGreaterThanOrEqual(1);

    const edge = depChangedEdges.find(e => e.targetNodeId === 'node_effect-1');
    expect(edge).toBeDefined();
    expect(edge!.sourceNodeId).toBe('node_render-1');
  });

  it('should produce effect_caused edge from effect to setState', () => {
    const graph = buildExecutionGraph(spans);
    const effectCausedEdges = graph.edges.filter(e => e.type === 'effect_caused');
    expect(effectCausedEdges.length).toBeGreaterThanOrEqual(1);

    const edge = effectCausedEdges.find(e => e.sourceNodeId === 'node_effect-1');
    expect(edge).toBeDefined();
  });

  it('should produce state_changed edge from effect to re-render', () => {
    const graph = buildExecutionGraph(spans);
    const stateChangedEdges = graph.edges.filter(e => e.type === 'state_changed');
    expect(stateChangedEdges.length).toBeGreaterThanOrEqual(1);

    // The re-render (render-2) should have a state_changed edge from the effect
    const edge = stateChangedEdges.find(e => e.targetNodeId === 'node_render-2');
    expect(edge).toBeDefined();
    expect(edge!.sourceNodeId).toBe('node_effect-1');
  });

  it('should detect the effect cascade cycle', () => {
    const graph = buildExecutionGraph(spans);
    const cycles = detectEffectCascadeCycles(spans, graph);
    expect(cycles.length).toBeGreaterThanOrEqual(1);
    expect(cycles[0].severity).toBe('warning');
    expect(cycles[0].recommendation).toContain('computed value');
  });

  it('should extract state snapshots as value snapshots', () => {
    const snapshots = extractValueSnapshots(spans);
    const stateSnapshots = snapshots.filter(s => s.boundary === 'state_before' || s.boundary === 'state_after');
    expect(stateSnapshots.length).toBeGreaterThanOrEqual(2); // at least one before/after pair
  });
});

// ─── Scenario R2: Prop Drilling Re-render Storm ──────────────────────────────
// Top-level state change triggers re-renders through 5 levels of components.
// Only one child has changed props; rest are unnecessary parent_rerendered.

describe('Scenario R2: Prop Drilling Re-render Storm', () => {
  const spans: RawSpan[] = [
    // Parent renders due to state change
    makeSpan({
      spanId: 'parent-render',
      name: 'App',
      startTimeMs: base,
      endTimeMs: base + 10,
      durationMs: 10,
      attributes: {
        'component.name': 'App',
        'code.function.type': 'react_component',
        'dt.react.render_cause': 'state_changed',
        'dt.react.changed_state_hooks': '[0]',
        'dt.react.state_before': '{"state[0]":""}',
        'dt.react.state_after': '{"state[0]":"search query"}',
        'dt.react.commit_id': 'commit_3',
      },
    }),
    // Child gets changed prop (searchQuery)
    makeSpan({
      spanId: 'child-render',
      parentSpanId: 'parent-render',
      name: 'SearchResults',
      startTimeMs: base + 1,
      endTimeMs: base + 4,
      durationMs: 3,
      attributes: {
        'component.name': 'SearchResults',
        'code.function.type': 'react_component',
        'dt.react.render_cause': 'prop_changed',
        'dt.react.changed_props': '["searchQuery"]',
        'dt.react.commit_id': 'commit_3',
      },
    }),
    // Sibling 1: unnecessary re-render (parent_rerendered)
    makeSpan({
      spanId: 'sibling1-render',
      parentSpanId: 'parent-render',
      name: 'Sidebar',
      startTimeMs: base + 1,
      endTimeMs: base + 3,
      durationMs: 2,
      attributes: {
        'component.name': 'Sidebar',
        'code.function.type': 'react_component',
        'dt.react.render_cause': 'parent_rerendered',
        'dt.react.commit_id': 'commit_3',
      },
    }),
    // Sibling 2: unnecessary re-render
    makeSpan({
      spanId: 'sibling2-render',
      parentSpanId: 'parent-render',
      name: 'Header',
      startTimeMs: base + 1,
      endTimeMs: base + 3,
      durationMs: 2,
      attributes: {
        'component.name': 'Header',
        'code.function.type': 'react_component',
        'dt.react.render_cause': 'parent_rerendered',
        'dt.react.commit_id': 'commit_3',
      },
    }),
    // Sibling 3: unnecessary re-render
    makeSpan({
      spanId: 'sibling3-render',
      parentSpanId: 'parent-render',
      name: 'Footer',
      startTimeMs: base + 1,
      endTimeMs: base + 3,
      durationMs: 2,
      attributes: {
        'component.name': 'Footer',
        'code.function.type': 'react_component',
        'dt.react.render_cause': 'parent_rerendered',
        'dt.react.commit_id': 'commit_3',
      },
    }),
  ];

  it('should identify correct render cause types', () => {
    const graph = buildExecutionGraph(spans);

    expect(graph.nodes.find(n => n.spanId === 'parent-render')?.type).toBe('react_render');
    expect(graph.nodes.find(n => n.spanId === 'child-render')?.type).toBe('react_render');
    expect(graph.nodes.find(n => n.spanId === 'sibling1-render')?.type).toBe('react_render');
  });

  it('should produce prop_changed edge for SearchResults', () => {
    const graph = buildExecutionGraph(spans);
    const propEdges = graph.edges.filter(e => e.type === 'prop_changed');
    expect(propEdges.length).toBe(1);
    expect(propEdges[0].targetNodeId).toBe('node_child-render');
    expect(propEdges[0].attributes?.changedProps).toContain('searchQuery');
  });

  it('should produce parent_rerendered edges for 3 siblings', () => {
    const graph = buildExecutionGraph(spans);
    const parentEdges = graph.edges.filter(e => e.type === 'parent_rerendered');
    expect(parentEdges.length).toBe(3);
  });

  it('should compute blast radius correctly', () => {
    const graph = buildExecutionGraph(spans);
    const radius = computeBlastRadius(graph, '0');

    expect(radius.totalRenders).toBeGreaterThanOrEqual(4); // parent + 3 siblings + child (from state_changed + parent_rerendered edges)
    expect(radius.unnecessaryRenders).toBe(3); // 3 siblings with parent_rerendered
    expect(radius.affectedComponents).toContain('Sidebar');
    expect(radius.affectedComponents).toContain('Header');
    expect(radius.affectedComponents).toContain('Footer');
  });

  it('should count renders per component correctly', () => {
    const counts = getRenderCountsByComponent(spans);

    const appCounts = counts.get('App');
    expect(appCounts).toBeDefined();
    expect(appCounts!.stateChanged).toBe(1);

    const sidebarCounts = counts.get('Sidebar');
    expect(sidebarCounts).toBeDefined();
    expect(sidebarCounts!.parentRerendered).toBe(1);
  });

  it('should report suspiciousness for unnecessary renders', () => {
    const graph = buildExecutionGraph(spans);
    const summary = buildTraceSummary(spans, graph);
    // 3 unnecessary renders × 5 points = 15 points minimum
    expect(summary.suspiciousnessScore).toBeGreaterThanOrEqual(15);
  });
});

// ─── Scenario R3: Async Race Condition ──────────────────────────────────────
// Two fetch calls update the same state. Resolution order matters.

describe('Scenario R3: Async Race Condition', () => {
  const spans: RawSpan[] = [
    // First click triggers fetch1
    makeSpan({
      spanId: 'click-1',
      name: 'handleClick',
      startTimeMs: base,
      endTimeMs: base + 5,
      durationMs: 5,
      attributes: {
        'dt.react.event_type': 'click',
        'dt.react.event_target': 'button#load',
      },
    }),
    // fetch1 started
    makeSpan({
      spanId: 'fetch-1',
      parentSpanId: 'click-1',
      name: 'fetch GET /api/user?id=abc',
      startTimeMs: base + 2,
      endTimeMs: base + 302,
      durationMs: 300,
      attributes: { 'http.url': '/api/user?id=abc', 'http.method': 'GET' },
    }),
    // Second click triggers fetch2
    makeSpan({
      spanId: 'click-2',
      name: 'handleClick',
      startTimeMs: base + 50,
      endTimeMs: base + 55,
      durationMs: 5,
      attributes: {
        'dt.react.event_type': 'click',
        'dt.react.event_target': 'button#load',
      },
    }),
    // fetch2 started (later, but resolves first)
    makeSpan({
      spanId: 'fetch-2',
      parentSpanId: 'click-2',
      name: 'fetch GET /api/user?id=def',
      startTimeMs: base + 52,
      endTimeMs: base + 152,
      durationMs: 100,
      attributes: { 'http.url': '/api/user?id=def', 'http.method': 'GET' },
    }),
    // fetch2 resolves first → setState(userData)
    makeSpan({
      spanId: 'render-fetch2',
      name: 'UserProfile',
      startTimeMs: base + 155,
      endTimeMs: base + 160,
      durationMs: 5,
      attributes: {
        'component.name': 'UserProfile',
        'dt.react.render_cause': 'state_changed',
        'dt.react.changed_state_hooks': '[0]',
        'dt.react.state_before': '{"state[0]":null}',
        'dt.react.state_after': '{"state[0]":"user-def-data"}',
      },
    }),
    // fetch1 resolves second → setState(userData) overwrites with stale data
    makeSpan({
      spanId: 'render-fetch1',
      name: 'UserProfile',
      startTimeMs: base + 305,
      endTimeMs: base + 310,
      durationMs: 5,
      attributes: {
        'component.name': 'UserProfile',
        'dt.react.render_cause': 'state_changed',
        'dt.react.changed_state_hooks': '[0]',
        'dt.react.state_before': '{"state[0]":"user-def-data"}',
        'dt.react.state_after': '{"state[0]":"user-abc-data"}',
      },
    }),
  ];

  it('should detect async race condition', () => {
    const graph = buildExecutionGraph(spans);
    const races = detectAsyncRaceConditions(spans, graph);
    expect(races.length).toBeGreaterThanOrEqual(1);
    expect(races[0].writers.length).toBe(2);
    expect(races[0].recommendation).toContain('AbortController');
  });

  it('should classify DOM event spans correctly', () => {
    const graph = buildExecutionGraph(spans);
    const click1 = graph.nodes.find(n => n.spanId === 'click-1');
    expect(click1?.type).toBe('dom_event');
  });

  it('should produce dom_event_triggered edges', () => {
    const graph = buildExecutionGraph(spans);
    const domEdges = graph.edges.filter(e => e.type === 'dom_event_triggered');
    expect(domEdges.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Scenario R4: Event → State → Render Chain ──────────────────────────────
// click button#save → handleSave() → setUserId('new') → <App> render → <UserProfile> render

describe('Scenario R4: Event → State → Render Chain', () => {
  const spans: RawSpan[] = [
    // DOM click event
    makeSpan({
      spanId: 'dom-click',
      name: 'click button#save',
      startTimeMs: base,
      endTimeMs: base + 2,
      durationMs: 2,
      attributes: {
        'dt.react.event_type': 'click',
        'dt.react.event_target': 'button#save',
      },
    }),
    // Event handler span
    makeSpan({
      spanId: 'handler-save',
      parentSpanId: 'dom-click',
      name: 'handleSave',
      startTimeMs: base + 1,
      endTimeMs: base + 5,
      durationMs: 4,
      attributes: {
        'function.name': 'handleSave',
        'code.filepath': 'app/page.tsx',
        'code.lineno': 42,
      },
    }),
    // App renders due to state change (setUserId called in handler)
    makeSpan({
      spanId: 'app-render',
      parentSpanId: 'handler-save',
      name: 'App',
      startTimeMs: base + 6,
      endTimeMs: base + 12,
      durationMs: 6,
      attributes: {
        'component.name': 'App',
        'code.function.type': 'react_component',
        'dt.react.render_cause': 'state_changed',
        'dt.react.changed_state_hooks': '[0]',
        'dt.react.state_before': '{"state[0]":"old-id"}',
        'dt.react.state_after': '{"state[0]":"new-id"}',
        'dt.react.set_state_caller_span_id': 'handler-save',
        'dt.react.commit_id': 'commit_4',
      },
    }),
    // UserProfile renders due to prop change (userId prop)
    makeSpan({
      spanId: 'profile-render',
      parentSpanId: 'app-render',
      name: 'UserProfile',
      startTimeMs: base + 7,
      endTimeMs: base + 10,
      durationMs: 3,
      attributes: {
        'component.name': 'UserProfile',
        'code.function.type': 'react_component',
        'dt.react.render_cause': 'prop_changed',
        'dt.react.changed_props': '["userId"]',
        'dt.react.commit_id': 'commit_4',
      },
    }),
    // Sidebar renders unnecessarily (parent re-rendered)
    makeSpan({
      spanId: 'sidebar-render',
      parentSpanId: 'app-render',
      name: 'Sidebar',
      startTimeMs: base + 7,
      endTimeMs: base + 9,
      durationMs: 2,
      attributes: {
        'component.name': 'Sidebar',
        'code.function.type': 'react_component',
        'dt.react.render_cause': 'parent_rerendered',
        'dt.react.commit_id': 'commit_4',
      },
    }),
  ];

  it('should create full event → state → render chain via edges', () => {
    const graph = buildExecutionGraph(spans);

    // dom_event → handler
    const domEdges = graph.edges.filter(e => e.type === 'dom_event_triggered');
    expect(domEdges.length).toBe(1);
    expect(domEdges[0].sourceNodeId).toBe('node_dom-click');
    expect(domEdges[0].targetNodeId).toBe('node_handler-save');

    // handler → App render (state_changed)
    const stateEdges = graph.edges.filter(e =>
      e.type === 'state_changed' && e.targetNodeId === 'node_app-render'
    );
    expect(stateEdges.length).toBe(1);
    expect(stateEdges[0].sourceNodeId).toBe('node_handler-save');

    // App render → UserProfile render (prop_changed)
    const propEdges = graph.edges.filter(e =>
      e.type === 'prop_changed' && e.targetNodeId === 'node_profile-render'
    );
    expect(propEdges.length).toBe(1);
    expect(propEdges[0].sourceNodeId).toBe('node_app-render');

    // App render → Sidebar render (parent_rerendered)
    const parentEdges = graph.edges.filter(e =>
      e.type === 'parent_rerendered' && e.targetNodeId === 'node_sidebar-render'
    );
    expect(parentEdges.length).toBe(1);
    expect(parentEdges[0].sourceNodeId).toBe('node_app-render');
  });

  it('should answer "why did UserProfile render?" via whyDidRender', () => {
    const graph = buildExecutionGraph(spans);
    const chain = whyDidRender(graph, 'profile-render');

    // Should trace back: UserProfile ← prop_changed from App ← state_changed from handleSave ← dom_event from click
    expect(chain.length).toBeGreaterThanOrEqual(1);

    // First cause: prop_changed from App render
    const propCause = chain.find(c => c.edgeType === 'prop_changed');
    expect(propCause).toBeDefined();
    expect(propCause!.nodeName).toBe('App');
  });

  it('should answer "why did Sidebar render?" as parent_rerendered', () => {
    const graph = buildExecutionGraph(spans);
    const chain = whyDidRender(graph, 'sidebar-render');

    const parentCause = chain.find(c => c.edgeType === 'parent_rerendered');
    expect(parentCause).toBeDefined();
  });
});

// ─── Scenario R5: State Transitions Extraction (Phase 3/4 Groundwork) ────────

describe('Scenario R5: State Transitions Extraction', () => {
  const spans: RawSpan[] = [
    makeSpan({
      spanId: 'form-idle',
      name: 'SubmitForm',
      startTimeMs: base,
      endTimeMs: base + 3,
      attributes: {
        'component.name': 'SubmitForm',
        'dt.react.render_cause': 'initial_mount',
      },
    }),
    makeSpan({
      spanId: 'form-loading',
      name: 'SubmitForm',
      startTimeMs: base + 100,
      endTimeMs: base + 103,
      attributes: {
        'component.name': 'SubmitForm',
        'dt.react.render_cause': 'state_changed',
        'dt.react.changed_state_hooks': '[0]',
        'dt.react.state_before': '{"state[0]":"idle"}',
        'dt.react.state_after': '{"state[0]":"loading"}',
      },
    }),
    makeSpan({
      spanId: 'form-success',
      name: 'SubmitForm',
      startTimeMs: base + 500,
      endTimeMs: base + 503,
      attributes: {
        'component.name': 'SubmitForm',
        'dt.react.render_cause': 'state_changed',
        'dt.react.changed_state_hooks': '[0]',
        'dt.react.state_before': '{"state[0]":"loading"}',
        'dt.react.state_after': '{"state[0]":"success"}',
      },
    }),
  ];

  it('should extract state transitions in order', () => {
    const transitions = extractStateTransitions(spans, 'SubmitForm');
    expect(transitions.length).toBe(2);

    // idle → loading
    expect(transitions[0].before).toContain('idle');
    expect(transitions[0].after).toContain('loading');

    // loading → success
    expect(transitions[1].before).toContain('loading');
    expect(transitions[1].after).toContain('success');
  });

  it('should capture render counts for behavioral diffing', () => {
    const counts = getRenderCountsByComponent(spans);
    const formCounts = counts.get('SubmitForm');
    expect(formCounts).toBeDefined();
    expect(formCounts!.total).toBe(3);
    expect(formCounts!.initialMount).toBe(1);
    expect(formCounts!.stateChanged).toBe(2);
  });
});

// ─── Scenario: Render count comparison (Phase 3 groundwork) ──────────────────

describe('Render count comparison in trace diff', () => {
  it('should detect render count differences between good and bad traces', () => {
    const goodSpans: RawSpan[] = [
      makeSpan({
        spanId: 'g-render-1',
        traceId: 'good-trace',
        name: 'UserProfile',
        attributes: {
          'component.name': 'UserProfile',
          'dt.react.render_cause': 'prop_changed',
        },
      }),
      makeSpan({
        spanId: 'g-render-2',
        traceId: 'good-trace',
        name: 'UserProfile',
        attributes: {
          'component.name': 'UserProfile',
          'dt.react.render_cause': 'state_changed',
        },
      }),
    ];

    const badSpans: RawSpan[] = [
      ...Array.from({ length: 7 }, (_, i) =>
        makeSpan({
          spanId: `b-render-${i}`,
          traceId: 'bad-trace',
          name: 'UserProfile',
          attributes: {
            'component.name': 'UserProfile',
            'dt.react.render_cause': i < 2 ? 'state_changed' : 'parent_rerendered',
          },
        })
      ),
    ];

    const diff = compareTraces(goodSpans, badSpans);
    // Should detect the render count change (2 → 7)
    const renderCountDiv = diff.divergences.find(d =>
      d.description.includes('render count')
    );
    expect(renderCountDiv).toBeDefined();
    expect(renderCountDiv!.goodValue).toContain('2');
    expect(renderCountDiv!.badValue).toContain('7');
  });
});
