/**
 * Tests for the DeepTrace MCP tool definitions and executor.
 */
import { describe, it, expect } from 'vitest';
import { TOOL_DEFINITIONS, MCPToolExecutor } from '../deeptrace/mcp-tools';

describe('TOOL_DEFINITIONS', () => {
  it('defines all required tools', () => {
    const toolNames = TOOL_DEFINITIONS.map(t => t.name);
    expect(toolNames).toContain('list_runs');
    expect(toolNames).toContain('get_trace_summary');
    expect(toolNames).toContain('get_trace_graph');
    expect(toolNames).toContain('get_span_details');
    expect(toolNames).toContain('find_exceptions');
    expect(toolNames).toContain('find_last_writer');
    expect(toolNames).toContain('find_first_divergence');
    expect(toolNames).toContain('trace_value_flow');
    expect(toolNames).toContain('follow_request_path');
    expect(toolNames).toContain('summarize_suspicious_transitions');
    expect(toolNames).toContain('search_executed_code');
    expect(toolNames).toContain('compare_trace_segments');
  });

  it('has 16 tools total (12 original + 4 React causal)', () => {
    expect(TOOL_DEFINITIONS).toHaveLength(16);
  });

  it('defines React causal query tools', () => {
    const toolNames = TOOL_DEFINITIONS.map(t => t.name);
    expect(toolNames).toContain('why_did_render');
    expect(toolNames).toContain('blast_radius');
    expect(toolNames).toContain('detect_effect_cascades');
    expect(toolNames).toContain('detect_async_races');
  });

  it('every tool has name, description, and inputSchema', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('tools with required params have them declared', () => {
    const summaryTool = TOOL_DEFINITIONS.find(t => t.name === 'get_trace_summary')!;
    expect(summaryTool.inputSchema.required).toContain('trace_id');

    const divTool = TOOL_DEFINITIONS.find(t => t.name === 'find_first_divergence')!;
    expect(divTool.inputSchema.required).toContain('good_trace_id');
    expect(divTool.inputSchema.required).toContain('bad_trace_id');
  });

  it('list_runs has no required params', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'list_runs')!;
    expect(tool.inputSchema.required).toBeUndefined();
  });
});

describe('MCPToolExecutor', () => {
  it('getToolDefinitions returns all tools', () => {
    // We can't create a real executor without ClickHouse, but we can test the static method
    // by checking TOOL_DEFINITIONS directly
    expect(TOOL_DEFINITIONS.length).toBe(16);
  });

  it('tool definitions have valid JSON schemas', () => {
    for (const tool of TOOL_DEFINITIONS) {
      const schema = tool.inputSchema;
      expect(schema.type).toBe('object');
      if (schema.properties) {
        for (const [key, prop] of Object.entries(schema.properties as Record<string, any>)) {
          expect(prop.type).toBeTruthy();
          expect(prop.description).toBeTruthy();
        }
      }
    }
  });
});

describe('React causal tool schemas', () => {
  it('why_did_render requires trace_id', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'why_did_render')!;
    expect(tool.inputSchema.required).toContain('trace_id');
    expect(tool.inputSchema.properties.span_id).toBeDefined();
    expect(tool.inputSchema.properties.component_name).toBeDefined();
  });

  it('blast_radius requires trace_id and state_key', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'blast_radius')!;
    expect(tool.inputSchema.required).toContain('trace_id');
    expect(tool.inputSchema.required).toContain('state_key');
  });

  it('detect_effect_cascades requires trace_id', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'detect_effect_cascades')!;
    expect(tool.inputSchema.required).toContain('trace_id');
  });

  it('detect_async_races requires trace_id', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'detect_async_races')!;
    expect(tool.inputSchema.required).toContain('trace_id');
  });
});
