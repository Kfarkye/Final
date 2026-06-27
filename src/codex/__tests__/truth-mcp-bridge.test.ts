/**
 * Test Harness: Truth MCP Bridge
 *
 * Tests the governed capability layer that sits between Codex and the Truth tool registry:
 *   - Tool filtering (blocked tools never exposed)
 *   - Approval policy enforcement
 *   - Tool execution routing through registry
 *   - Schema generation for Codex discovery
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock tool registry — must be before the import
vi.mock('../../tools/index.js', () => ({
  toolRegistry: {
    getSchemas: vi.fn().mockReturnValue({
      get_odds: { description: 'Get live odds', properties: { team: { type: 'string' } }, required: ['team'] },
      get_scores: { description: 'Get live scores', properties: {}, required: [] },
      deploy_staged_mcp: { description: 'Deploy to staging', properties: {} },
      trigger_deploy: { description: 'Trigger deploy', properties: {} },
      rotate_odds_key: { description: 'Rotate API key', properties: {} },
      run_odds_ingestor_once: { description: 'Run ingestor', properties: {} },
      github_write_file: { description: 'Write file to GitHub', properties: {} },
      github_create_pr: { description: 'Create PR', properties: {} },
      spanner_admin_execute: { description: 'Admin Spanner', properties: {} },
    }),
    execute: vi.fn().mockResolvedValue({ data: 'mock result' }),
  },
}));

import {
  getCodexToolDefinitions,
  getCodexAllowedTools,
  evaluateToolAccess,
  executeCodexToolCall,
} from '../truth-mcp-bridge';

import { toolRegistry } from '../../tools/index.js';

describe('Truth MCP Bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-mock getSchemas to fresh return value
    vi.mocked(toolRegistry.getSchemas).mockReturnValue({
      get_odds: { name: 'get_odds', description: 'Get live odds', parameters: { type: 'object', properties: { team: { type: 'string' } }, required: ['team'] }, properties: { team: { type: 'string' } }, required: ['team'] },
      get_scores: { name: 'get_scores', description: 'Get live scores', parameters: { type: 'object', properties: {}, required: [] }, properties: {}, required: [] },
      deploy_staged_mcp: { name: 'deploy_staged_mcp', description: 'Deploy to staging', parameters: { type: 'object', properties: {} }, properties: {} },
      trigger_deploy: { name: 'trigger_deploy', description: 'Trigger deploy', parameters: { type: 'object', properties: {} }, properties: {} },
      rotate_odds_key: { name: 'rotate_odds_key', description: 'Rotate API key', parameters: { type: 'object', properties: {} }, properties: {} },
      run_odds_ingestor_once: { name: 'run_odds_ingestor_once', description: 'Run ingestor', parameters: { type: 'object', properties: {} }, properties: {} },
      github_write_file: { name: 'github_write_file', description: 'Write file to GitHub', parameters: { type: 'object', properties: {} }, properties: {} },
      github_create_pr: { name: 'github_create_pr', description: 'Create PR', parameters: { type: 'object', properties: {} }, properties: {} },
      spanner_admin_execute: { name: 'spanner_admin_execute', description: 'Admin Spanner', parameters: { type: 'object', properties: {} }, properties: {} },
    });
  });

  describe('Approval Policy via evaluateToolAccess', () => {
    it('requires human approval for deploy_staged_mcp', () => {
      const result = evaluateToolAccess('deploy_staged_mcp', {}, { tenantId: 'test', requestId: 'req' });
      expect(result).toBe('needs_human');
    });

    it('requires human approval for trigger_deploy', () => {
      const result = evaluateToolAccess('trigger_deploy', {}, { tenantId: 'test', requestId: 'req' });
      expect(result).toBe('needs_human');
    });

    it('requires human approval for rotate_odds_key', () => {
      const result = evaluateToolAccess('rotate_odds_key', {}, { tenantId: 'test', requestId: 'req' });
      expect(result).toBe('needs_human');
    });

    it('requires human approval for run_odds_ingestor_once', () => {
      const result = evaluateToolAccess('run_odds_ingestor_once', {}, { tenantId: 'test', requestId: 'req' });
      expect(result).toBe('needs_human');
    });

    it('requires human approval for spanner_admin_execute', () => {
      const result = evaluateToolAccess('spanner_admin_execute', {}, { tenantId: 'test', requestId: 'req' });
      expect(result).toBe('needs_human');
    });

    it('allows read-only tools', () => {
      const result = evaluateToolAccess('get_odds', {}, { tenantId: 'test', requestId: 'req' });
      expect(result).toHaveProperty('allow', true);
    });

    it('allows get_scores', () => {
      const result = evaluateToolAccess('get_scores', {}, { tenantId: 'test', requestId: 'req' });
      expect(result).toHaveProperty('allow', true);
    });
  });

  describe('Approval Policy via evaluateToolAccess (GitHub)', () => {
    it('requires human approval for github_write_file', () => {
      const result = evaluateToolAccess('github_write_file', {}, { tenantId: 'test', requestId: 'req' });
      expect(result).toBe('needs_human');
    });

    it('requires human approval for github_create_pr', () => {
      const result = evaluateToolAccess('github_create_pr', {}, { tenantId: 'test', requestId: 'req' });
      expect(result).toBe('needs_human');
    });

    it('auto-approves read-only tools', () => {
      const result = evaluateToolAccess('get_odds', {}, { tenantId: 'test', requestId: 'req' });
      expect(result).not.toBe('needs_human');
      expect(result).toHaveProperty('allow', true);
    });
  });

  describe('Tool Filtering', () => {
    it('getCodexAllowedTools includes all tools (none blocked)', () => {
      const allowed = getCodexAllowedTools();

      // All tools should be visible — approval is checked at execution time, not at listing
      expect(allowed).toContain('get_odds');
      expect(allowed).toContain('get_scores');
      expect(allowed).toContain('github_write_file');
      expect(allowed).toContain('github_create_pr');
      expect(allowed).toContain('deploy_staged_mcp');
      expect(allowed).toContain('trigger_deploy');
      expect(allowed).toContain('rotate_odds_key');
      expect(allowed).toContain('run_odds_ingestor_once');
      expect(allowed).toContain('spanner_admin_execute');
    });
  });

  describe('Tool Definitions (MCP-compatible)', () => {
    it('returns schemas for all tools including approval-required', () => {
      const defs = getCodexToolDefinitions();
      const names = defs.map(d => d.name);

      expect(names).toContain('get_odds');
      expect(names).toContain('get_scores');
      expect(names).toContain('deploy_staged_mcp');
      expect(names).toContain('spanner_admin_execute');
    });

    it('each definition has name, description, inputSchema', () => {
      const defs = getCodexToolDefinitions();
      for (const def of defs) {
        expect(def).toHaveProperty('name');
        expect(def).toHaveProperty('description');
        expect(def).toHaveProperty('inputSchema');
        expect(def.inputSchema).toHaveProperty('type', 'object');
      }
    });

    it('carries through input schema properties', () => {
      const defs = getCodexToolDefinitions();
      const oddsDef = defs.find(d => d.name === 'get_odds')!;

      expect(oddsDef.inputSchema.properties).toHaveProperty('team');
      expect(oddsDef.inputSchema.required).toContain('team');
    });
  });

  describe('Tool Execution', () => {
    it('routes execution through the tool registry', async () => {
      const result = await executeCodexToolCall('get_odds', { team: 'Yankees' }, {
        connectionId: 'test-conn',
        userTimezone: 'America/New_York',
      });

      expect(toolRegistry.execute).toHaveBeenCalledWith(
        'get_odds',
        { team: 'Yankees' },
        expect.objectContaining({ connectionId: 'test-conn' })
      );
      expect(result).toEqual({ data: 'mock result' });
    });

    it('allows approval-required tools to execute (approval checked in handler)', async () => {
      const result = await executeCodexToolCall('deploy_staged_mcp', {}, { connectionId: 'test' });
      expect(toolRegistry.execute).toHaveBeenCalled();
      expect(result).toEqual({ data: 'mock result' });
    });

    it('allows spanner_admin_execute to execute (approval checked in handler)', async () => {
      const result = await executeCodexToolCall('spanner_admin_execute', {}, { connectionId: 'test' });
      expect(toolRegistry.execute).toHaveBeenCalled();
      expect(result).toEqual({ data: 'mock result' });
    });

    it('allows github tools to execute (approval checked in handler)', async () => {
      const result = await executeCodexToolCall('github_write_file', { path: 'test.md', content: 'hello' }, {
        connectionId: 'test',
      });
      expect(toolRegistry.execute).toHaveBeenCalled();
      expect(result).toEqual({ data: 'mock result' });
    });
  });
});
