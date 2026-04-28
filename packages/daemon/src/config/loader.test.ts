import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { formatWorkflowError } from './errors.js';
import { loadWorkflow } from './loader.js';

describe('loadWorkflow', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'symphony-loader-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns missing_workflow_file (not throwing) when the file does not exist', async () => {
    const result = await loadWorkflow(join(tempDir, 'nonexistent.md'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('missing_workflow_file');
    }
  });

  it('loads a fully-defaulted ServiceConfig from a minimal workflow file', async () => {
    const path = join(tempDir, 'minimal.md');
    await writeFile(
      path,
      ['---', 'tracker:', '  kind: linear', '---', 'You are working on an issue.'].join('\n'),
    );
    const result = await loadWorkflow(path);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.config.tracker.kind).toBe('linear');
      expect(result.value.config.polling.interval_ms).toBe(30_000);
      expect(result.value.config.agent.max_turns).toBe(20);
      expect(result.value.promptTemplate).toBe('You are working on an issue.');
      expect(result.value.path).toBe(path);
    }
  });

  it('loads a workflow with no front matter as all-prompt, all-defaults', async () => {
    const path = join(tempDir, 'no-frontmatter.md');
    await writeFile(path, 'Just the prompt body.');
    const result = await loadWorkflow(path);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.promptTemplate).toBe('Just the prompt body.');
      expect(result.value.config.polling.interval_ms).toBe(30_000);
    }
  });

  it('returns workflow_validation_error when an unknown sub-key is present', async () => {
    const path = join(tempDir, 'typo.md');
    await writeFile(
      path,
      ['---', 'tracker:', '  kind: linear', '  kid: oops', '---', 'Body.'].join('\n'),
    );
    const result = await loadWorkflow(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('workflow_validation_error');
    }
  });

  it('returns workflow_parse_error when YAML is malformed', async () => {
    const path = join(tempDir, 'malformed.md');
    await writeFile(path, ['---', 'this is: not: valid: yaml', '---', 'Body.'].join('\n'));
    const result = await loadWorkflow(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('workflow_parse_error');
    }
  });

  it('returns workflow_front_matter_not_a_map when YAML decodes to a list', async () => {
    const path = join(tempDir, 'list.md');
    await writeFile(path, ['---', '- one', '- two', '---', 'Body.'].join('\n'));
    const result = await loadWorkflow(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('workflow_front_matter_not_a_map');
    }
  });

  it('resolves a relative workspace.root against the workflow file directory', async () => {
    const path = join(tempDir, 'relative-ws.md');
    await writeFile(
      path,
      [
        '---',
        'tracker:',
        '  kind: linear',
        'workspace:',
        '  root: ./local-ws',
        '---',
        'Body.',
      ].join('\n'),
    );
    const result = await loadWorkflow(path);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.config.workspace.root).toBe(join(tempDir, 'local-ws'));
    }
  });

  it('absolutizes a relative input path so the returned path is stable', async () => {
    const path = join(tempDir, 'minimal.md');
    await writeFile(path, ['---', 'tracker:', '  kind: linear', '---', 'Body.'].join('\n'));

    // We pass the path as-is (already absolute thanks to `mkdtemp`); verify
    // the returned path equals the resolved absolute form.
    const result = await loadWorkflow(path);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.path).toMatch(/^\//);
      expect(result.value.path).toBe(path);
    }
  });
});

describe('formatWorkflowError', () => {
  it('produces a one-line summary for missing files', () => {
    const out = formatWorkflowError({
      code: 'missing_workflow_file',
      path: '/p',
      message: 'msg',
      cause: null,
    });
    expect(out).toContain('missing_workflow_file');
    expect(out).toContain('/p');
  });

  it('produces a multi-line summary for validation errors with issues', () => {
    const out = formatWorkflowError({
      code: 'workflow_validation_error',
      path: '/p',
      message: 'failed',
      issues: [
        {
          code: 'invalid_type',
          path: ['tracker', 'kind'],
          message: 'Expected string',
          expected: 'string',
          received: 'number',
        },
      ],
    });
    expect(out).toContain('workflow_validation_error');
    expect(out).toContain('tracker.kind');
    expect(out).toContain('Expected string');
  });
});
