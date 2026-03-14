import { useEffect, useState } from 'react';
import { getSource } from '../api/client';
import type { SourceFile } from '../types';

// Simple syntax token types
type TokenType = 'keyword' | 'string' | 'comment' | 'number' | 'operator' | 'function' | 'type' | 'plain';

interface Token {
  type: TokenType;
  text: string;
}

const KEYWORD_RE = /\b(import|export|from|const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|this|class|extends|implements|interface|type|enum|async|await|try|catch|finally|throw|typeof|instanceof|in|of|default|yield|void|null|undefined|true|false)\b/;
const STRING_RE = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/;
const COMMENT_RE = /(\/\/.*$|\/\*[\s\S]*?\*\/)/m;
const NUMBER_RE = /\b(\d+\.?\d*(?:e[+-]?\d+)?)\b/;
const TYPE_RE = /\b([A-Z][a-zA-Z0-9]*(?:<[^>]+>)?)\b/;

function tokenizeLine(line: string): Token[] {
  const tokens: Token[] = [];
  let remaining = line;

  while (remaining.length > 0) {
    let matched = false;

    // Try each pattern
    for (const [re, type] of [
      [COMMENT_RE, 'comment'],
      [STRING_RE, 'string'],
      [KEYWORD_RE, 'keyword'],
      [NUMBER_RE, 'number'],
      [TYPE_RE, 'type'],
    ] as [RegExp, TokenType][]) {
      const m = remaining.match(re);
      if (m && m.index !== undefined) {
        if (m.index > 0) {
          tokens.push({ type: 'plain', text: remaining.slice(0, m.index) });
        }
        tokens.push({ type, text: m[0] });
        remaining = remaining.slice(m.index + m[0].length);
        matched = true;
        break;
      }
    }

    if (!matched) {
      // Take one character
      tokens.push({ type: 'plain', text: remaining[0] });
      remaining = remaining.slice(1);
    }
  }

  return tokens;
}

const TOKEN_COLORS: Record<TokenType, string> = {
  keyword: 'text-purple-400',
  string: 'text-emerald-400',
  comment: 'text-gray-600 italic',
  number: 'text-amber-400',
  operator: 'text-gray-400',
  function: 'text-blue-400',
  type: 'text-cyan-400',
  plain: 'text-gray-300',
};

interface Props {
  filePath: string;
  highlightLine: number;
  highlightColumn?: number;
}

export function SourceViewer({ filePath, highlightLine, highlightColumn }: Props) {
  const [source, setSource] = useState<SourceFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getSource(filePath)
      .then(setSource)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [filePath]);

  if (loading) {
    return <div className="text-sm text-gray-500 animate-pulse">Loading source...</div>;
  }

  if (error) {
    return (
      <div className="bg-surface-2 rounded-md p-3">
        <div className="text-xs text-gray-500 mb-1">Could not load source file</div>
        <div className="text-xs font-mono text-gray-400">{filePath}</div>
        <div className="text-xs text-accent-red mt-1">{error}</div>
      </div>
    );
  }

  if (!source) return null;

  const lines = source.content.split('\n');
  // Show context around the highlighted line
  const contextLines = 15;
  const startLine = Math.max(0, highlightLine - contextLines - 1);
  const endLine = Math.min(lines.length, highlightLine + contextLines);
  const visibleLines = lines.slice(startLine, endLine);

  return (
    <div className="rounded-md overflow-hidden border border-surface-3">
      {/* File header */}
      <div className="bg-surface-2 px-3 py-2 flex items-center justify-between border-b border-surface-3">
        <div className="flex items-center gap-2 text-xs">
          <LanguageIcon language={source.language} />
          <span className="font-mono text-gray-300">{filePath}</span>
          {highlightLine > 0 && (
            <span className="text-gray-500">
              :{highlightLine}{highlightColumn ? `:${highlightColumn}` : ''}
            </span>
          )}
        </div>
        <span className="text-[10px] text-gray-600">{source.lineCount} lines</span>
      </div>

      {/* Code */}
      <div className="overflow-x-auto bg-surface-0">
        <pre className="text-xs leading-5 py-2">
          {visibleLines.map((line, i) => {
            const lineNum = startLine + i + 1;
            const isHighlighted = lineNum === highlightLine;
            const tokens = tokenizeLine(line);

            return (
              <div
                key={lineNum}
                className={`flex ${
                  isHighlighted
                    ? 'bg-amber-500/10 border-l-2 border-amber-400'
                    : 'border-l-2 border-transparent'
                }`}
              >
                <span
                  className={`w-12 shrink-0 text-right pr-4 select-none ${
                    isHighlighted ? 'text-amber-400 font-bold' : 'text-gray-600'
                  }`}
                >
                  {lineNum}
                </span>
                <code className="flex-1 pr-4">
                  {tokens.map((token, j) => (
                    <span key={j} className={TOKEN_COLORS[token.type]}>
                      {token.text}
                    </span>
                  ))}
                </code>
              </div>
            );
          })}
        </pre>
      </div>
    </div>
  );
}

function LanguageIcon({ language }: { language: string }) {
  const colors: Record<string, string> = {
    typescript: 'text-blue-400',
    tsx: 'text-blue-400',
    javascript: 'text-yellow-400',
    jsx: 'text-yellow-400',
    python: 'text-green-400',
    rust: 'text-orange-400',
  };

  return (
    <span className={`text-[10px] uppercase font-bold ${colors[language] || 'text-gray-500'}`}>
      {language.slice(0, 3)}
    </span>
  );
}
