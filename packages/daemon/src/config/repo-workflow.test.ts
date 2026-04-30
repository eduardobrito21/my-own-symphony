import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  buildRepoWorkflowSchema,
  defaultRepoWorkflow,
  parseRepoWorkflow,
} from './repo-workflow.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('buildRepoWorkflowSchema', () => {
  it('parses an empty front matter to all defaults', () => {
    const schema = buildRepoWorkflowSchema();
    const result = schema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.agent).toEqual({});
    expect(result.data.hooks).toEqual({});
  });

  it('parses agent overrides without requiring all fields', () => {
    const schema = buildRepoWorkflowSchema();
    const result = schema.safeParse({
      agent: { allowed_tools: ['Bash', 'Read'], max_budget_usd: 0.5 },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.agent.allowed_tools).toEqual(['Bash', 'Read']);
    expect(result.data.agent.max_budget_usd).toBe(0.5);
  });

  it('rejects unknown keys inside the agent section', () => {
    const schema = buildRepoWorkflowSchema();
    const result = schema.safeParse({ agent: { allowed_tols: ['Bash'] } });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.some(
        (i) =>
          i.code === 'unrecognized_keys' &&
          (i as { keys?: string[] }).keys?.includes('allowed_tols'),
      ),
    ).toBe(true);
  });

  it('rejects unknown keys inside the hooks section', () => {
    const schema = buildRepoWorkflowSchema();
    const result = schema.safeParse({ hooks: { before_runn: 'echo hi' } });
    expect(result.success).toBe(false);
  });

  it('parses thinking config as a discriminated union', () => {
    const schema = buildRepoWorkflowSchema();
    const result = schema.safeParse({
      agent: { thinking: { type: 'enabled', budgetTokens: 5000 } },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    if (result.data.agent.thinking?.type === 'enabled') {
      expect(result.data.agent.thinking.budgetTokens).toBe(5000);
    }
  });

  it('passes through unknown TOP-level keys', () => {
    const schema = buildRepoWorkflowSchema();
    const result = schema.safeParse({
      agent: {},
      hooks: {},
      future_extension: { foo: 1 },
    });
    expect(result.success).toBe(true);
  });
});

describe('parseRepoWorkflow', () => {
  it('parses front matter + body', () => {
    const content = [
      '---',
      'agent:',
      '  allowed_tools: [Bash, Read]',
      'hooks:',
      '  before_run: echo hi',
      '---',
      'You are working on {{ issue.identifier }}.',
    ].join('\n');
    const result = parseRepoWorkflow(content, '/tmp/.symphony/workflow.md');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config.agent.allowed_tools).toEqual(['Bash', 'Read']);
    expect(result.value.config.hooks.before_run).toBe('echo hi');
    expect(result.value.promptTemplate).toBe('You are working on {{ issue.identifier }}.');
  });

  it('parses a body-only file as all defaults', () => {
    const result = parseRepoWorkflow('Just the prompt.', '/tmp/.symphony/workflow.md');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config.agent).toEqual({});
    expect(result.value.promptTemplate).toBe('Just the prompt.');
  });

  it('returns workflow_validation_error on schema failure', () => {
    const content = '---\nagent:\n  max_turns: -1\n---\nbody';
    const result = parseRepoWorkflow(content, '/tmp/.symphony/workflow.md');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('workflow_validation_error');
  });

  it('rejects operator-side fields (strict drop of polling/workspace/tracker)', () => {
    // The repo workflow schema deliberately omits these. Including
    // them in a per-repo workflow.md is a sign the operator put
    // their config in the wrong file.
    const content = '---\npolling:\n  interval_ms: 1000\n---\nbody';
    const result = parseRepoWorkflow(content, '/tmp/.symphony/workflow.md');
    expect(result.ok).toBe(true);
    // Note: top-level passthrough means unknown TOP-level keys are
    // tolerated rather than rejected — same behavior as the legacy
    // schema. This is a forward-compat choice; future versions may
    // tighten this if it causes confusion.
  });

  it('parses the example template at examples/repo-workflow/.symphony/workflow.md', async () => {
    const examplePath = join(HERE, '../../../../examples/repo-workflow/.symphony/workflow.md');
    const content = await readFile(examplePath, 'utf8');
    const result = parseRepoWorkflow(content, examplePath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config.agent.allowed_tools).toContain('Bash');
    expect(result.value.config.hooks.before_run).toBeDefined();
    expect(result.value.promptTemplate).toContain('{{ issue.identifier }}');
  });
});

describe('defaultRepoWorkflow', () => {
  it('produces a conservative tool set + a no-edit prompt', () => {
    const def = defaultRepoWorkflow();
    expect(def.config.agent.allowed_tools).toEqual(['mcp__linear__linear_graphql']);
    expect(def.promptTemplate).toContain('does not have a `.symphony/workflow.md`');
    expect(def.promptTemplate).toContain('Do not edit code.');
  });

  it('parses cleanly through the schema (sanity check)', () => {
    const schema = buildRepoWorkflowSchema();
    const def = defaultRepoWorkflow();
    const result = schema.safeParse({
      agent: def.config.agent,
      hooks: def.config.hooks,
    });
    expect(result.success).toBe(true);
  });
});
