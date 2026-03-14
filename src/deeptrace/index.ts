/**
 * DeepTrace Runtime Context Debugging Platform
 *
 * Public API barrel file.
 */

// Core types
export * from './types';

// Enrichment engine
export {
  buildExecutionGraph,
  buildTraceSummary,
  buildTraceRun,
  compareTraces,
  extractValueSnapshots,
  type RawSpan,
} from './enrichment';

// Redaction
export {
  redactAttributes,
  isVisibleTo,
  getVisibilityTags,
  createRedactionPolicy,
} from './redaction';

// Query API
export { DeepTraceQueryAPI, type QueryAPIConfig } from './query-api';

// MCP tools
export { MCPToolExecutor, TOOL_DEFINITIONS } from './mcp-tools';

// Server
export { createDeepTraceServer, startDeepTraceServer, type ServerConfig } from './server';
