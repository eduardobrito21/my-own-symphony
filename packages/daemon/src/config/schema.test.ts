import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildServiceConfigSchema } from './schema.js';

const BASE_DIR = '/tmp/symphony-test-base';

describe('buildServiceConfigSchema', () => {
  const ORIGINAL = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL };
  });

  afterEach(() => {
    process.env = ORIGINAL;
  });

  describe('defaults', () => {
    it('fills in all defaults when given an empty object', () => {
      const schema = buildServiceConfigSchema(BASE_DIR);
      const result = schema.parse({});
      expect(result.tracker.endpoint).toBe('https://api.linear.app/graphql');
      expect(result.tracker.active_states).toEqual(['Todo', 'In Progress']);
      expect(result.tracker.terminal_states).toEqual([
        'Closed',
        'Cancelled',
        'Canceled',
        'Duplicate',
        'Done',
      ]);
      expect(result.polling.interval_ms).toBe(30_000);
      expect(result.workspace.root).toBe(join(tmpdir(), 'symphony_workspaces'));
      expect(result.hooks.timeout_ms).toBe(60_000);
      expect(result.agent.max_concurrent_agents).toBe(10);
      expect(result.agent.max_turns).toBe(20);
      expect(result.agent.max_retry_backoff_ms).toBe(300_000);
      expect(result.agent.max_concurrent_agents_by_state).toEqual({});
      expect(result.agent.turn_timeout_ms).toBe(3_600_000);
      expect(result.agent.read_timeout_ms).toBe(5_000);
      expect(result.agent.stall_timeout_ms).toBe(300_000);
    });

    it('accepts a minimal config with just tracker.kind', () => {
      const schema = buildServiceConfigSchema(BASE_DIR);
      const result = schema.parse({ tracker: { kind: 'linear' } });
      expect(result.tracker.kind).toBe('linear');
      expect(result.polling.interval_ms).toBe(30_000);
    });
  });

  describe('forward compatibility', () => {
    it('preserves unknown top-level keys (extension forward-compat)', () => {
      const schema = buildServiceConfigSchema(BASE_DIR);
      const result = schema.parse({
        tracker: { kind: 'linear' },
        server: { port: 3000 },
      });
      expect(result).toMatchObject({ server: { port: 3000 } });
    });

    it('rejects unknown keys inside a known section (typo catching)', () => {
      const schema = buildServiceConfigSchema(BASE_DIR);
      expect(() => schema.parse({ tracker: { kind: 'linear', kid: 'oops' } })).toThrow(/kid/);
    });
  });

  describe('tracker.api_key env resolution', () => {
    it('resolves a $VAR_NAME api_key against the environment', () => {
      process.env['SYMPHONY_TEST_LINEAR_KEY'] = 'lin_test_token';
      const schema = buildServiceConfigSchema(BASE_DIR);
      const result = schema.parse({
        tracker: { kind: 'linear', api_key: '$SYMPHONY_TEST_LINEAR_KEY' },
      });
      expect(result.tracker.api_key).toBe('lin_test_token');
    });

    it('preserves a literal api_key string unchanged', () => {
      const schema = buildServiceConfigSchema(BASE_DIR);
      const result = schema.parse({
        tracker: { kind: 'linear', api_key: 'lin_literal_token' },
      });
      expect(result.tracker.api_key).toBe('lin_literal_token');
    });

    it('fails validation when the referenced env var is empty', () => {
      process.env['SYMPHONY_EMPTY_KEY'] = '';
      const schema = buildServiceConfigSchema(BASE_DIR);
      expect(() =>
        schema.parse({ tracker: { kind: 'linear', api_key: '$SYMPHONY_EMPTY_KEY' } }),
      ).toThrow(/unset or empty/);
    });
  });

  describe('workspace.root path resolution', () => {
    it('expands a leading ~ in workspace.root', () => {
      const schema = buildServiceConfigSchema(BASE_DIR);
      const result = schema.parse({ workspace: { root: '~/symphony-ws' } });
      expect(result.workspace.root).toBe(`${homedir()}/symphony-ws`);
    });

    it('absolutizes a relative workspace.root against the workflow base directory', () => {
      const schema = buildServiceConfigSchema(BASE_DIR);
      const result = schema.parse({ workspace: { root: 'relative-ws' } });
      expect(result.workspace.root).toBe(`${BASE_DIR}/relative-ws`);
    });

    it('resolves $VAR -> path through the full pipeline', () => {
      process.env['SYMPHONY_WS_ROOT'] = '~/from-env-ws';
      const schema = buildServiceConfigSchema(BASE_DIR);
      const result = schema.parse({ workspace: { root: '$SYMPHONY_WS_ROOT' } });
      expect(result.workspace.root).toBe(`${homedir()}/from-env-ws`);
    });

    it('leaves an absolute workspace.root unchanged', () => {
      const schema = buildServiceConfigSchema(BASE_DIR);
      const result = schema.parse({ workspace: { root: '/absolute/ws' } });
      expect(result.workspace.root).toBe('/absolute/ws');
    });
  });

  describe('agent.max_concurrent_agents_by_state', () => {
    it('lowercases state-name keys for consistent lookup', () => {
      const schema = buildServiceConfigSchema(BASE_DIR);
      const result = schema.parse({
        agent: { max_concurrent_agents_by_state: { 'In Progress': 3, TODO: 5 } },
      });
      expect(result.agent.max_concurrent_agents_by_state).toEqual({
        'in progress': 3,
        todo: 5,
      });
    });

    it('silently drops invalid entries (non-positive or non-numeric)', () => {
      const schema = buildServiceConfigSchema(BASE_DIR);
      const result = schema.parse({
        agent: {
          max_concurrent_agents_by_state: {
            valid: 2,
            zero: 0,
            negative: -3,
            float: 1.5,
            string: 'nope',
            null_value: null,
          },
        },
      });
      expect(result.agent.max_concurrent_agents_by_state).toEqual({ valid: 2 });
    });
  });

  describe('numeric validation', () => {
    it('rejects a non-positive max_turns', () => {
      const schema = buildServiceConfigSchema(BASE_DIR);
      expect(() => schema.parse({ agent: { max_turns: 0 } })).toThrow();
      expect(() => schema.parse({ agent: { max_turns: -1 } })).toThrow();
    });

    it('rejects a non-positive polling.interval_ms', () => {
      const schema = buildServiceConfigSchema(BASE_DIR);
      expect(() => schema.parse({ polling: { interval_ms: 0 } })).toThrow();
    });

    it('accepts agent.stall_timeout_ms = 0 (disable signal per SPEC §5.3.6)', () => {
      const schema = buildServiceConfigSchema(BASE_DIR);
      const result = schema.parse({ agent: { stall_timeout_ms: 0 } });
      expect(result.agent.stall_timeout_ms).toBe(0);
    });

    it('accepts agent.stall_timeout_ms < 0 (also a disable signal)', () => {
      const schema = buildServiceConfigSchema(BASE_DIR);
      const result = schema.parse({ agent: { stall_timeout_ms: -1 } });
      expect(result.agent.stall_timeout_ms).toBe(-1);
    });
  });

  describe('legacy codex.* compatibility', () => {
    it('passes a `codex` section through untouched without erroring (forward-compat)', () => {
      // ADR 0008: a WORKFLOW.md authored for upstream Symphony with a
      // `codex.command` line should still parse here. The section is
      // ignored by our typed schema (top-level passthrough).
      const schema = buildServiceConfigSchema(BASE_DIR);
      const result = schema.parse({
        tracker: { kind: 'linear' },
        codex: { command: 'codex app-server', turn_timeout_ms: 1234 },
      });
      expect(result).toMatchObject({ codex: { command: 'codex app-server' } });
      // And our agent timeouts still default correctly:
      expect(result.agent.turn_timeout_ms).toBe(3_600_000);
    });
  });
});
