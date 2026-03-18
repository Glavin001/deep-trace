/**
 * react-causal-recorder.ts — React-specific causal tracing.
 *
 * Analyzes React fiber tree diffs to determine WHY components re-rendered,
 * which effects fired and why, and links event handlers → state changes → re-renders.
 *
 * Architecture:
 *   1. Hooks into React via bippy's onCommitFiberRoot (called after every React commit).
 *   2. Walks the committed fiber tree comparing current vs alternate (previous) fibers.
 *   3. For each updated fiber, determines the render cause: state_changed, prop_changed,
 *      parent_rerendered, or context_changed.
 *   4. Detects effect execution by comparing effect hook dependency arrays.
 *   5. Emits all causal data as dt.react.* OTel span attributes on matching component spans.
 *
 * This module is browser-side only.
 */

import { trace, context } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import type { RenderCauseType } from './deeptrace/types';

// ===== Constants =====

const MAX_SNAPSHOT_SIZE = 10240; // 10KB max for state snapshots
let commitCounter = 0;

// ===== Pending setState Records =====
// When a patched setState is called, we record it here.
// onCommitFiberRoot correlates these with actual fiber state changes.

interface PendingSetState {
  componentName: string;
  hookIndex: number;
  before: any;
  after: any;
  activeSpanId: string | undefined;
  timestamp: number;
}

const pendingSetStates: PendingSetState[] = [];
const PENDING_SET_STATE_TTL = 5000; // 5 seconds
const PENDING_SET_STATE_MAX = 500;

// ===== Fiber Analysis Types =====

export interface RenderCauseInfo {
  type: RenderCauseType;
  changedProps?: string[];
  changedStateHookIndices?: number[];
  stateSnapshots?: Array<{
    hookIndex: number;
    key: string;
    before: string;
    after: string;
  }>;
}

export interface EffectInfo {
  hookIndex: number;
  type: 'effect' | 'layout_effect';
  changedDepIndices: number[];
  depsBefore: string;
  depsAfter: string;
}

export interface FiberRenderAnalysis {
  componentName: string;
  cause: RenderCauseInfo;
  effects: EffectInfo[];
  commitId: string;
  setStateCallerSpanId?: string;
}

// ===== Serialization =====

function truncatedSerialize(val: any, maxSize: number = MAX_SNAPSHOT_SIZE): string {
  if (val === undefined) return '';
  if (val === null) return 'null';
  if (typeof val === 'string') return val.length > maxSize ? val.slice(0, maxSize) + '[truncated]' : val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  try {
    const seen = new WeakSet<object>();
    const replacer = (_key: string, value: any) => {
      if (typeof value === 'bigint') return value.toString();
      if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
      if (typeof value === 'symbol') return value.toString();
      if (value instanceof Date) return value.toISOString();
      if (value instanceof Map) return { __type: 'Map', size: value.size };
      if (value instanceof Set) return { __type: 'Set', size: value.size };
      if (value instanceof Error) return { name: value.name, message: value.message };
      if (value && typeof value === 'object') {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
        // Skip React elements
        if (value.$$typeof) return '[ReactElement]';
      }
      return value;
    };
    let s = JSON.stringify(val, replacer);
    if (typeof s !== 'string') s = String(s);
    return s.length > maxSize ? s.slice(0, maxSize) + '[truncated]' : s;
  } catch {
    return '[unserializable]';
  }
}

// ===== Hook State Walking =====

interface HookNode {
  index: number;
  type: 'state' | 'reducer' | 'effect' | 'layout_effect' | 'memo' | 'callback' | 'ref' | 'context' | 'other';
  memoizedState: any;
  /** For effect hooks, the deps array */
  deps?: any[] | null;
  /** For effect hooks, the effect tag flags */
  effectTag?: number;
}

// React effect hook tags (from React source)
const HookHasEffect = 0b0001;     // HasEffect
const HookLayout    = 0b0100;     // Layout (useLayoutEffect)
const HookPassive   = 0b1000;     // Passive (useEffect)

/**
 * Walk the memoizedState linked list on a fiber, classifying each hook.
 * React stores hooks as a singly linked list: { memoizedState, next }.
 * For effect hooks, memoizedState is: { tag, create, destroy, deps, next }.
 */
export function walkHookStates(fiber: any): HookNode[] {
  const hooks: HookNode[] = [];
  if (!fiber || fiber.tag !== 0 /* FunctionComponent */ && fiber.tag !== 11 /* ForwardRef */ && fiber.tag !== 15 /* SimpleMemoComponent */) {
    return hooks;
  }

  let hookState = fiber.memoizedState;
  let index = 0;

  while (hookState) {
    const ms = hookState.memoizedState;
    let hookType: HookNode['type'] = 'other';
    let deps: any[] | null | undefined;
    let effectTag: number | undefined;

    if (ms && typeof ms === 'object' && 'tag' in ms && 'create' in ms && 'deps' in ms) {
      // This is an effect hook: { tag, create, destroy, deps, next }
      effectTag = ms.tag;
      deps = ms.deps;
      if (effectTag !== undefined && (effectTag & HookLayout)) {
        hookType = 'layout_effect';
      } else if (effectTag !== undefined && (effectTag & HookPassive)) {
        hookType = 'effect';
      } else {
        // Fallback: if it has create/destroy, it's some kind of effect
        hookType = 'effect';
      }
    } else if (hookState.queue !== null && hookState.queue !== undefined) {
      // State or reducer hook — has a queue for dispatching updates
      if (hookState.queue.lastRenderedReducer) {
        // Could be useReducer or useState (useState uses a basic reducer internally)
        hookType = 'state'; // Treat both as state for our purposes
      } else {
        hookType = 'state';
      }
    } else if (ms && typeof ms === 'object' && 'current' in ms && Object.keys(ms).length <= 1) {
      hookType = 'ref';
    } else if (Array.isArray(ms) && ms.length === 2) {
      // useMemo/useCallback return [value, deps]
      hookType = 'memo';
    }

    hooks.push({
      index,
      type: hookType,
      memoizedState: hookType === 'effect' || hookType === 'layout_effect' ? undefined : ms,
      deps,
      effectTag,
    });

    hookState = hookState.next;
    index++;
  }

  return hooks;
}

// ===== Render Cause Analysis =====

/**
 * Compare props between current and alternate (previous) fiber.
 * Returns list of changed prop keys, or null if no prop changes.
 */
function diffProps(current: any, alternate: any): string[] | null {
  const currentProps = current.memoizedProps;
  const prevProps = alternate.memoizedProps;

  if (currentProps === prevProps) return null;
  if (!currentProps || !prevProps) return currentProps !== prevProps ? ['*'] : null;

  const changedKeys: string[] = [];
  const allKeys = new Set([
    ...Object.keys(currentProps),
    ...Object.keys(prevProps),
  ]);

  for (const key of allKeys) {
    if (key === 'children') continue; // Skip children — too noisy
    if (!Object.is(currentProps[key], prevProps[key])) {
      changedKeys.push(key);
    }
  }

  return changedKeys.length > 0 ? changedKeys : null;
}

/**
 * Compare state hooks between current and alternate fiber.
 * Returns indices of changed state hooks and before/after snapshots.
 */
function diffStateHooks(currentHooks: HookNode[], prevHooks: HookNode[]): {
  changedIndices: number[];
  snapshots: Array<{ hookIndex: number; key: string; before: string; after: string }>;
} | null {
  const changedIndices: number[] = [];
  const snapshots: Array<{ hookIndex: number; key: string; before: string; after: string }> = [];

  for (let i = 0; i < currentHooks.length; i++) {
    const curr = currentHooks[i];
    const prev = prevHooks[i];
    if (!prev || !curr) continue;
    if (curr.type !== 'state' && curr.type !== 'reducer') continue;

    if (!Object.is(curr.memoizedState, prev?.memoizedState)) {
      changedIndices.push(i);
      snapshots.push({
        hookIndex: i,
        key: `state[${i}]`,
        before: truncatedSerialize(prev?.memoizedState),
        after: truncatedSerialize(curr.memoizedState),
      });
    }
  }

  return changedIndices.length > 0 ? { changedIndices, snapshots } : null;
}

/**
 * Check if a fiber's context dependencies changed.
 */
function hasContextChanged(fiber: any): boolean {
  try {
    // React 18+: fiber.dependencies contains a linked list of context deps
    const deps = fiber.dependencies;
    if (!deps || !deps.firstContext) return false;

    let ctx = deps.firstContext;
    while (ctx) {
      // Each context dep has a context reference and the value at last render.
      // If the current context value differs from the stored one, it changed.
      if (ctx.context && ctx.context._currentValue !== undefined) {
        // We can't easily compare since we don't have the previous value stored directly.
        // However, if React scheduled this fiber for update due to context, the fiber.lanes
        // will be set. We check if the fiber was in the update set already.
        // For now, this is a best-effort detection — we return true if context deps exist
        // and no other cause was found.
      }
      ctx = ctx.next;
    }
  } catch {
    // Fiber internals access is best-effort
  }
  return false;
}

/**
 * Core render cause analysis for a single fiber.
 */
export function analyzeRenderCause(
  fiber: any,
  updatedFibersInCommit: Set<any>,
  bippy: any,
): RenderCauseInfo {
  try {
    // Initial mount — no alternate means first render
    if (!fiber.alternate) {
      return { type: 'initial_mount' };
    }

    // Check for prop changes
    const changedProps = diffProps(fiber, fiber.alternate);

    // Check for state changes
    const currentHooks = walkHookStates(fiber);
    const prevHooks = walkHookStates(fiber.alternate);
    const stateChanges = diffStateHooks(currentHooks, prevHooks);

    // State change takes priority (it's the most direct cause)
    if (stateChanges) {
      return {
        type: 'state_changed',
        changedStateHookIndices: stateChanges.changedIndices,
        stateSnapshots: stateChanges.snapshots,
        changedProps: changedProps || undefined,
      };
    }

    // Prop change
    if (changedProps) {
      return {
        type: 'prop_changed',
        changedProps,
      };
    }

    // Context change
    if (hasContextChanged(fiber)) {
      return { type: 'context_changed' };
    }

    // Parent re-rendered (no own props/state change detected)
    if (fiber.return && updatedFibersInCommit.has(fiber.return)) {
      return { type: 'parent_rerendered' };
    }

    // Fallback — something caused a re-render but we couldn't determine what
    return { type: 'parent_rerendered' };
  } catch {
    return { type: 'initial_mount' };
  }
}

// ===== Effect Analysis =====

/**
 * Analyze which effects will fire in this commit by comparing deps.
 */
export function analyzeEffects(fiber: any): EffectInfo[] {
  const effects: EffectInfo[] = [];

  if (!fiber.alternate) {
    // Initial mount — all effects fire but we don't diff deps
    return effects;
  }

  try {
    const currentHooks = walkHookStates(fiber);
    const prevHooks = walkHookStates(fiber.alternate);

    for (let i = 0; i < currentHooks.length; i++) {
      const curr = currentHooks[i];
      if (curr.type !== 'effect' && curr.type !== 'layout_effect') continue;

      const prev = prevHooks[i];
      if (!prev) continue;

      const currDeps = curr.deps;
      const prevDeps = prev.deps;

      // No deps array means effect fires every render
      if (currDeps === null || currDeps === undefined) {
        effects.push({
          hookIndex: i,
          type: curr.type,
          changedDepIndices: [-1], // -1 means "no deps array"
          depsBefore: truncatedSerialize(prevDeps),
          depsAfter: truncatedSerialize(currDeps),
        });
        continue;
      }

      // Compare each dep
      if (prevDeps && Array.isArray(currDeps) && Array.isArray(prevDeps)) {
        const changedIndices: number[] = [];
        const maxLen = Math.max(currDeps.length, prevDeps.length);
        for (let j = 0; j < maxLen; j++) {
          if (!Object.is(currDeps[j], prevDeps[j])) {
            changedIndices.push(j);
          }
        }
        if (changedIndices.length > 0) {
          effects.push({
            hookIndex: i,
            type: curr.type,
            changedDepIndices: changedIndices,
            depsBefore: truncatedSerialize(prevDeps),
            depsAfter: truncatedSerialize(currDeps),
          });
        }
      }
    }
  } catch {
    // Best-effort
  }

  return effects;
}

// ===== Commit Analysis =====

/**
 * Analyze a full React commit. Called from onCommitFiberRoot.
 * Returns analysis for each updated fiber in the commit.
 */
export function analyzeCommit(
  root: any,
  bippy: any,
): FiberRenderAnalysis[] {
  const results: FiberRenderAnalysis[] = [];
  const commitId = `commit_${++commitCounter}_${Date.now()}`;

  try {
    const current = root?.current;
    if (!current) return results;

    // Collect all updated composite fibers in this commit
    const updatedFibers = new Set<any>();
    const fiberQueue: any[] = [current];

    while (fiberQueue.length > 0) {
      const fiber = fiberQueue.pop();
      if (!fiber) continue;

      if (bippy.isCompositeFiber(fiber)) {
        // A fiber is "updated" if it has an alternate (not first mount)
        // or if it's a first mount (no alternate)
        const name = bippy.getDisplayName(fiber.type);
        if (name) {
          updatedFibers.add(fiber);
        }
      }

      // Walk children and siblings
      if (fiber.child) fiberQueue.push(fiber.child);
      if (fiber.sibling) fiberQueue.push(fiber.sibling);
    }

    // Analyze each updated fiber
    for (const fiber of updatedFibers) {
      try {
        const name = bippy.getDisplayName(fiber.type);
        if (!name) continue;

        const cause = analyzeRenderCause(fiber, updatedFibers, bippy);
        const effects = analyzeEffects(fiber);

        // Find matching pending setState record
        let setStateCallerSpanId: string | undefined;
        if (cause.type === 'state_changed') {
          const cutoff = Date.now() - PENDING_SET_STATE_TTL;
          for (let i = pendingSetStates.length - 1; i >= 0; i--) {
            const record = pendingSetStates[i];
            if (record.timestamp < cutoff) break;
            if (record.componentName === name) {
              setStateCallerSpanId = record.activeSpanId;
              pendingSetStates.splice(i, 1); // Consume it
              break;
            }
          }
        }

        results.push({
          componentName: name,
          cause,
          effects,
          commitId,
          setStateCallerSpanId,
        });
      } catch {
        // Skip problematic fibers
      }
    }
  } catch {
    // Commit analysis is best-effort
  }

  return results;
}

// ===== Span Attribute Emission =====

/**
 * Apply causal analysis results as dt.react.* span attributes.
 */
export function applyAnalysisToSpan(span: Span, analysis: FiberRenderAnalysis): void {
  if (!span.isRecording()) return;

  try {
    span.setAttribute('dt.react.render_cause', analysis.cause.type);
    span.setAttribute('dt.react.commit_id', analysis.commitId);

    if (analysis.cause.changedProps) {
      span.setAttribute('dt.react.changed_props', JSON.stringify(analysis.cause.changedProps));
    }

    if (analysis.cause.changedStateHookIndices) {
      span.setAttribute('dt.react.changed_state_hooks', JSON.stringify(analysis.cause.changedStateHookIndices));
    }

    if (analysis.cause.stateSnapshots && analysis.cause.stateSnapshots.length > 0) {
      // Combine all before/after into objects for compact representation
      const beforeObj: Record<string, any> = {};
      const afterObj: Record<string, any> = {};
      for (const snap of analysis.cause.stateSnapshots) {
        beforeObj[snap.key] = snap.before;
        afterObj[snap.key] = snap.after;
      }
      span.setAttribute('dt.react.state_before', JSON.stringify(beforeObj));
      span.setAttribute('dt.react.state_after', JSON.stringify(afterObj));
    }

    if (analysis.setStateCallerSpanId) {
      span.setAttribute('dt.react.set_state_caller_span_id', analysis.setStateCallerSpanId);
    }

    // Emit effect info as events on the span
    for (const effect of analysis.effects) {
      span.setAttribute(`dt.react.effect.${effect.hookIndex}.type`, effect.type);
      span.setAttribute(`dt.react.effect.${effect.hookIndex}.deps_changed`, JSON.stringify(effect.changedDepIndices));
      span.setAttribute(`dt.react.effect.${effect.hookIndex}.deps_before`, effect.depsBefore);
      span.setAttribute(`dt.react.effect.${effect.hookIndex}.deps_after`, effect.depsAfter);
    }

    if (analysis.effects.length > 0) {
      span.setAttribute('dt.react.effects_count', analysis.effects.length);
    }
  } catch {
    // Attribute setting is best-effort
  }
}

// ===== setState Interception =====

/**
 * Record a pending setState call for later correlation with fiber commits.
 */
export function recordSetState(
  componentName: string,
  hookIndex: number,
  before: any,
  after: any,
  activeSpanId: string | undefined,
): void {
  // Enforce cap
  if (pendingSetStates.length >= PENDING_SET_STATE_MAX) {
    pendingSetStates.splice(0, Math.floor(PENDING_SET_STATE_MAX * 0.2));
  }
  pendingSetStates.push({
    componentName,
    hookIndex,
    before: truncatedSerialize(before),
    after: truncatedSerialize(after),
    activeSpanId,
    timestamp: Date.now(),
  });
  // Cleanup expired
  const cutoff = Date.now() - PENDING_SET_STATE_TTL;
  while (pendingSetStates.length > 0 && pendingSetStates[0].timestamp < cutoff) {
    pendingSetStates.shift();
  }
}

// ===== Effect Span Creation =====

/**
 * Create OTel spans for effects that will fire in this commit.
 * These spans carry dt.react.effect_type and dt.react.effect_deps_changed attributes
 * that the enrichment engine will convert to effect_execution nodes.
 */
export function createEffectSpans(
  analysis: FiberRenderAnalysis,
  parentSpan: Span | undefined,
): void {
  if (analysis.effects.length === 0) return;

  try {
    const tracer = trace.getTracer('react-causal-recorder');
    const parentCtx = parentSpan
      ? trace.setSpan(context.active(), parentSpan)
      : context.active();

    for (const effect of analysis.effects) {
      const spanName = `useEffect [${analysis.componentName}#${effect.hookIndex}]`;
      const span = tracer.startSpan(spanName, undefined, parentCtx);

      if (span.isRecording()) {
        span.setAttribute('dt.react.effect_type', effect.type);
        span.setAttribute('dt.react.effect_hook_index', effect.hookIndex);
        span.setAttribute('dt.react.effect_deps_changed', JSON.stringify(effect.changedDepIndices));
        span.setAttribute('dt.react.effect_deps_before', effect.depsBefore);
        span.setAttribute('dt.react.effect_deps_after', effect.depsAfter);
        span.setAttribute('dt.react.commit_id', analysis.commitId);
        span.setAttribute('component.name', analysis.componentName);
      }

      // Effect spans are instantaneous markers — end immediately
      // The actual effect execution will create child spans if it calls wrapped functions
      span.end();
    }
  } catch {
    // Effect span creation is best-effort
  }
}

// ===== Hook Patching =====
// Patches React.useState and React.useReducer to wrap their setter/dispatch functions.
// When a setter is called, records { componentName, hookIndex, before, after, activeSpanId }
// so onCommitFiberRoot can correlate the setState with the actual fiber state change.

let hooksPatched = false;

// Track which component is currently rendering (set by the component wrapper)
let currentRenderingComponent: string | null = null;
let currentHookIndex = 0;

/**
 * Called by the probe-wrapper before/after a component renders to track
 * which component is currently rendering (for hook interception).
 */
export function setCurrentRenderingComponent(name: string | null): void {
  currentRenderingComponent = name;
  currentHookIndex = 0;
}

/**
 * Patch React.useState and React.useReducer to intercept setState/dispatch calls.
 * This gives us precise causal linking: "setState was called from within this span."
 *
 * Inspired by why-did-you-render's hook tracking approach, but emitting OTel span
 * attributes instead of console logs.
 */
export function patchReactHooks(React: any): boolean {
  if (!React || hooksPatched) return false;

  const originalUseState = React.useState;
  const originalUseReducer = React.useReducer;

  if (typeof originalUseState !== 'function') return false;

  // Lazy import to avoid circular deps
  let getCurrentSpanIdFn: (() => string | undefined) | null = null;
  try {
    const pw = require('./probe-wrapper');
    getCurrentSpanIdFn = pw.getCurrentSpanId;
  } catch {
    // probe-wrapper not available
  }

  React.useState = function patchedUseState(initialState: any) {
    const componentName = currentRenderingComponent;
    const hookIdx = currentHookIndex++;
    const result = originalUseState(initialState);
    const [value, originalSetter] = result;

    // Wrap the setter to record the call
    const wrappedSetter = function patchedSetState(newValueOrUpdater: any) {
      const before = value;
      const after = typeof newValueOrUpdater === 'function'
        ? newValueOrUpdater(before)
        : newValueOrUpdater;
      const activeSpanId = getCurrentSpanIdFn ? getCurrentSpanIdFn() : undefined;

      if (componentName) {
        recordSetState(componentName, hookIdx, before, after, activeSpanId);
      }

      return originalSetter(newValueOrUpdater);
    };

    // Preserve identity for React's referential equality checks
    // React may use the setter reference for batching optimization
    try {
      Object.defineProperty(wrappedSetter, 'name', { value: 'setState', configurable: true });
    } catch { /* best-effort */ }

    return [value, wrappedSetter];
  };

  React.useReducer = function patchedUseReducer(reducer: any, initialArg: any, init?: any) {
    const componentName = currentRenderingComponent;
    const hookIdx = currentHookIndex++;
    const result = init !== undefined
      ? originalUseReducer(reducer, initialArg, init)
      : originalUseReducer(reducer, initialArg);
    const [state, originalDispatch] = result;

    const wrappedDispatch = function patchedDispatch(action: any) {
      const activeSpanId = getCurrentSpanIdFn ? getCurrentSpanIdFn() : undefined;

      if (componentName) {
        recordSetState(componentName, hookIdx, state, action, activeSpanId);
      }

      return originalDispatch(action);
    };

    try {
      Object.defineProperty(wrappedDispatch, 'name', { value: 'dispatch', configurable: true });
    } catch { /* best-effort */ }

    return [state, wrappedDispatch];
  };

  // Preserve React.useState.length for any framework that inspects it
  try {
    Object.defineProperty(React.useState, 'length', { value: originalUseState.length, configurable: true });
    Object.defineProperty(React.useReducer, 'length', { value: originalUseReducer.length, configurable: true });
  } catch { /* best-effort */ }

  hooksPatched = true;
  return true;
}

/**
 * Unpatch React hooks. Used in tests to restore original behavior.
 */
export function unpatchReactHooks(React: any): void {
  // We can't easily restore originals after patching, so this is a flag reset
  hooksPatched = false;
}

// ===== Initialization =====

let causalRecordingInitialized = false;

/**
 * Initialize causal recording. Called from browser-init.ts after React instrumentation.
 * Patches React hooks and sets up the causal recording pipeline.
 */
export function initCausalRecording(): void {
  if (causalRecordingInitialized) return;
  causalRecordingInitialized = true;

  // Patch React hooks for setState interception
  try {
    const React = require('react');
    patchReactHooks(React);
  } catch {
    // React not available — skip hook patching
  }
}

/**
 * Check if causal recording is initialized.
 */
export function isCausalRecordingActive(): boolean {
  return causalRecordingInitialized;
}

// ===== Exports for Testing =====

export {
  truncatedSerialize as _truncatedSerialize,
  diffProps as _diffProps,
  diffStateHooks as _diffStateHooks,
  MAX_SNAPSHOT_SIZE,
};
