import { useState } from 'react';
import type { Span } from '../types';
import { SourceViewer } from './SourceViewer';

interface Props {
  span: Span;
  onClose: () => void;
}

type Tab = 'attributes' | 'source' | 'args';

export function SpanDetailPanel({ span, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('attributes');

  const attrs = span.attributes || {};
  const filePath = attrs['code.filepath'] || attrs['component.fiber.source'] || '';
  const lineNo = parseInt(attrs['code.lineno']) || 0;
  const column = parseInt(attrs['code.column']) || 0;
  const funcName = attrs['function.name'] || span.name;
  const funcType = attrs['function.type'] || '';
  const callerName = attrs['function.caller.name'] || '';
  const hierarchy = attrs['component.hierarchy'] || '';

  // Extract function arguments
  const argEntries: [string, string][] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('function.args.') && key !== 'function.args.count') {
      argEntries.push([key.replace('function.args.', 'arg[') + ']', value]);
    }
  }
  const returnValue = attrs['function.return.value'] || '';

  const tabs: { key: Tab; label: string; show: boolean }[] = [
    { key: 'attributes', label: 'Attributes', show: true },
    { key: 'source', label: 'Source', show: !!filePath },
    { key: 'args', label: 'Args / Return', show: argEntries.length > 0 || !!returnValue },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="bg-surface-1 border-b border-surface-3 px-4 py-3 flex items-center justify-between">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-white truncate">{span.name}</h3>
          <div className="text-xs text-gray-500 mt-0.5 font-mono">{span.spanId}</div>
        </div>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-gray-300 p-1"
          aria-label="Close"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>

      {/* Quick info cards */}
      <div className="grid grid-cols-2 gap-2 p-4">
        <InfoCard label="Duration" value={formatDuration(span.durationMs)} />
        <InfoCard label="Service" value={span.serviceName} />
        {funcType && <InfoCard label="Type" value={friendlyFuncType(funcType)} />}
        {callerName && <InfoCard label="Called by" value={callerName} />}
        {filePath && (
          <InfoCard
            label="Source"
            value={`${filePath}${lineNo ? `:${lineNo}` : ''}`}
            className="col-span-2"
            mono
          />
        )}
        {hierarchy && (
          <InfoCard label="Component tree" value={hierarchy} className="col-span-2" />
        )}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-surface-3 px-4">
        {tabs.filter(t => t.show).map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              tab === t.key
                ? 'border-accent-blue text-accent-blue'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto">
        {tab === 'attributes' && (
          <AttributesTab attrs={attrs} />
        )}
        {tab === 'source' && filePath && (
          <div className="p-4">
            <SourceViewer filePath={filePath} highlightLine={lineNo} highlightColumn={column} />
          </div>
        )}
        {tab === 'args' && (
          <ArgsTab args={argEntries} returnValue={returnValue} />
        )}
      </div>
    </div>
  );
}

function InfoCard({ label, value, className = '', mono = false }: {
  label: string;
  value: string;
  className?: string;
  mono?: boolean;
}) {
  return (
    <div className={`bg-surface-2 rounded-md px-3 py-2 ${className}`}>
      <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-0.5">{label}</div>
      <div className={`text-sm text-gray-200 truncate ${mono ? 'font-mono text-xs' : ''}`}>{value}</div>
    </div>
  );
}

function AttributesTab({ attrs }: { attrs: Record<string, string> }) {
  const entries = Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b));

  if (entries.length === 0) {
    return <div className="p-4 text-sm text-gray-500">No attributes</div>;
  }

  // Group by prefix
  const groups = new Map<string, [string, string][]>();
  for (const [key, value] of entries) {
    const prefix = key.split('.')[0];
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix)!.push([key, value]);
  }

  return (
    <div className="p-4 space-y-3">
      {[...groups.entries()].map(([prefix, items]) => (
        <div key={prefix}>
          <div className="text-[10px] uppercase tracking-wider text-gray-600 mb-1">{prefix}</div>
          <div className="bg-surface-2 rounded-md overflow-hidden">
            {items.map(([key, value]) => (
              <div key={key} className="flex border-b border-surface-3/50 last:border-0">
                <div className="text-xs font-mono text-gray-400 px-3 py-1.5 w-[180px] shrink-0 truncate">
                  {key}
                </div>
                <div className="text-xs font-mono text-gray-200 px-3 py-1.5 flex-1 break-all">
                  {formatAttrValue(value)}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ArgsTab({ args, returnValue }: { args: [string, string][]; returnValue: string }) {
  return (
    <div className="p-4 space-y-4">
      {args.length > 0 && (
        <div>
          <div className="text-xs font-medium text-gray-400 mb-2">Arguments</div>
          <div className="space-y-2">
            {args.map(([key, value]) => (
              <div key={key} className="bg-surface-2 rounded-md p-3">
                <div className="text-[10px] text-gray-500 font-mono mb-1">{key}</div>
                <pre className="text-xs font-mono text-gray-200 whitespace-pre-wrap break-all">
                  {formatJsonValue(value)}
                </pre>
              </div>
            ))}
          </div>
        </div>
      )}
      {returnValue && (
        <div>
          <div className="text-xs font-medium text-gray-400 mb-2">Return Value</div>
          <div className="bg-surface-2 rounded-md p-3">
            <pre className="text-xs font-mono text-accent-green whitespace-pre-wrap break-all">
              {formatJsonValue(returnValue)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function friendlyFuncType(type: string): string {
  const map: Record<string, string> = {
    user_function: 'Function',
    react_component: 'React Component',
    http_handler: 'HTTP Handler',
  };
  return map[type] || type;
}

function formatAttrValue(value: string): string {
  if (value.length > 200) return value.slice(0, 200) + '...';
  return value;
}

function formatJsonValue(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
