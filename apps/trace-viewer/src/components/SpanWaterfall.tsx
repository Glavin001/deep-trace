import type { Span } from '../types';
import { parseTimestamp } from '../utils';

// Color scheme per service name (cycles through)
const SERVICE_COLORS = [
  'bg-blue-500', 'bg-purple-500', 'bg-cyan-500', 'bg-amber-500',
  'bg-emerald-500', 'bg-rose-500', 'bg-indigo-500', 'bg-teal-500',
];

const SERVICE_COLORS_LIGHT = [
  'bg-blue-400/20', 'bg-purple-400/20', 'bg-cyan-400/20', 'bg-amber-400/20',
  'bg-emerald-400/20', 'bg-rose-400/20', 'bg-indigo-400/20', 'bg-teal-400/20',
];

interface Props {
  spans: Span[];
  traceStart: number;
  traceDuration: number;
  selectedSpanId: string | null;
  onSelectSpan: (span: Span) => void;
}

interface SpanNode {
  span: Span;
  children: SpanNode[];
  depth: number;
}

function buildTree(spans: Span[]): SpanNode[] {
  const map = new Map<string, SpanNode>();
  const roots: SpanNode[] = [];

  // Create nodes
  for (const span of spans) {
    map.set(span.spanId, { span, children: [], depth: 0 });
  }

  // Build tree
  for (const span of spans) {
    const node = map.get(span.spanId)!;
    if (span.parentSpanId && map.has(span.parentSpanId)) {
      const parent = map.get(span.parentSpanId)!;
      parent.children.push(node);
      node.depth = parent.depth + 1;
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function flattenTree(nodes: SpanNode[]): SpanNode[] {
  const result: SpanNode[] = [];
  function walk(node: SpanNode) {
    result.push(node);
    // Sort children by start time
    node.children.sort(
      (a, b) => new Date(a.span.timestamp).getTime() - new Date(b.span.timestamp).getTime(),
    );
    for (const child of node.children) {
      child.depth = node.depth + 1;
      walk(child);
    }
  }
  for (const root of nodes) walk(root);
  return result;
}

export function SpanWaterfall({ spans, traceStart, traceDuration, selectedSpanId, onSelectSpan }: Props) {
  const tree = buildTree(spans);
  const flatSpans = flattenTree(tree);
  const serviceNames = [...new Set(spans.map(s => s.serviceName))];
  const serviceColorMap = new Map(serviceNames.map((name, i) => [name, i % SERVICE_COLORS.length]));

  // Time grid lines
  const gridLines = 5;
  const gridInterval = traceDuration / gridLines;

  return (
    <div className="min-w-[600px]">
      {/* Service legend */}
      <div className="flex items-center gap-4 mb-3">
        {serviceNames.map(name => {
          const colorIdx = serviceColorMap.get(name)!;
          return (
            <div key={name} className="flex items-center gap-1.5 text-xs text-gray-400">
              <div className={`w-3 h-3 rounded-sm ${SERVICE_COLORS[colorIdx]}`} />
              {name}
            </div>
          );
        })}
      </div>

      {/* Time axis */}
      <div className="flex items-end mb-1 ml-[280px] relative h-5">
        {Array.from({ length: gridLines + 1 }).map((_, i) => (
          <div
            key={i}
            className="absolute text-[10px] text-gray-600 -translate-x-1/2"
            style={{ left: `${(i / gridLines) * 100}%` }}
          >
            {formatDurationShort(gridInterval * i)}
          </div>
        ))}
      </div>

      {/* Span rows */}
      <div className="border border-surface-3 rounded-lg overflow-hidden">
        {flatSpans.map(({ span, depth }) => {
          const spanStart = parseTimestamp(span.timestamp) - traceStart;
          const left = traceDuration > 0 ? (spanStart / traceDuration) * 100 : 0;
          const width = traceDuration > 0 ? Math.max((span.durationMs / traceDuration) * 100, 0.5) : 100;
          const colorIdx = serviceColorMap.get(span.serviceName) || 0;
          const isSelected = span.spanId === selectedSpanId;
          const isError = span.statusCode === 'STATUS_CODE_ERROR';
          const funcType = span.attributes?.['function.type'] || '';

          return (
            <div
              key={span.spanId}
              className={`flex items-center border-b border-surface-3/50 hover:bg-surface-2/50 cursor-pointer transition-colors ${
                isSelected ? 'bg-surface-2 ring-1 ring-inset ring-accent-blue/30' : ''
              }`}
              onClick={() => onSelectSpan(span)}
            >
              {/* Span name column */}
              <div
                className="w-[280px] shrink-0 px-3 py-2 truncate"
                style={{ paddingLeft: `${12 + depth * 20}px` }}
              >
                {depth > 0 && (
                  <span className="text-surface-3 mr-1">{'└'}</span>
                )}
                <span className={`text-sm ${isError ? 'text-accent-red' : 'text-gray-200'} font-medium`}>
                  {span.name}
                </span>
                {funcType && (
                  <span className="text-[10px] text-gray-600 ml-1.5">
                    {funcType === 'react_component' ? 'RC' : funcType === 'http_handler' ? 'HTTP' : 'fn'}
                  </span>
                )}
              </div>

              {/* Waterfall column */}
              <div className="flex-1 relative h-8 mr-3">
                {/* Grid lines */}
                {Array.from({ length: gridLines + 1 }).map((_, i) => (
                  <div
                    key={i}
                    className="absolute top-0 h-full border-l border-surface-3/30"
                    style={{ left: `${(i / gridLines) * 100}%` }}
                  />
                ))}

                {/* Span bar */}
                <div
                  className={`absolute top-1.5 h-5 rounded-sm transition-all flex items-center ${
                    isError
                      ? 'bg-red-500/30 border border-red-500/50'
                      : `${SERVICE_COLORS_LIGHT[colorIdx]} border border-transparent`
                  }`}
                  style={{
                    left: `${left}%`,
                    width: `${Math.max(width, 0.5)}%`,
                    minWidth: '4px',
                  }}
                >
                  <div
                    className={`h-full rounded-sm ${isError ? 'bg-red-500' : SERVICE_COLORS[colorIdx]}`}
                    style={{ width: '100%', opacity: 0.8 }}
                  />
                  {width > 8 && (
                    <span className="absolute right-1 text-[10px] text-gray-300 font-mono whitespace-nowrap">
                      {formatDurationShort(span.durationMs)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatDurationShort(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
