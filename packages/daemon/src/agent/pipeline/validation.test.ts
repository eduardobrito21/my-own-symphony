import { describe, expect, it } from 'vitest';

import { extractFencedJsonBlocks, findSandboxHandleInText } from './validation.js';

const validHandle = {
  id: 'symphony-eng-123',
  kind: 'local-docker',
  worktree_path: '/tmp/workspaces/eng-123',
  exec: {
    kind: 'shell-template',
    template: 'docker compose -p symphony-eng-123 exec app {cmd}',
  },
  teardown: {
    kind: 'script',
    script: 'docker compose -p symphony-eng-123 down -v',
  },
};

describe('extractFencedJsonBlocks', () => {
  it('returns [] when no fence present', () => {
    expect(extractFencedJsonBlocks('plain text, no code blocks here')).toEqual([]);
  });

  it('returns [] for non-json fences', () => {
    const text = '```bash\necho hi\n```';
    expect(extractFencedJsonBlocks(text)).toEqual([]);
  });

  it('extracts a single json block', () => {
    const text = 'preface\n```json\n{"a":1}\n```\ntrailer';
    expect(extractFencedJsonBlocks(text)).toEqual(['{"a":1}']);
  });

  it('extracts multiple json blocks in order', () => {
    const text = '```json\n{"first":true}\n```\nthen\n```json\n{"second":true}\n```';
    expect(extractFencedJsonBlocks(text)).toEqual(['{"first":true}', '{"second":true}']);
  });

  it('is case-insensitive on the info string', () => {
    const text = '```JSON\n{"a":1}\n```';
    expect(extractFencedJsonBlocks(text)).toEqual(['{"a":1}']);
  });

  it('ignores fences with trailing info after json', () => {
    // ```json5 is intentionally a different language; should not match.
    const text = '```json5\n{"a":1}\n```';
    expect(extractFencedJsonBlocks(text)).toEqual([]);
  });
});

describe('findSandboxHandleInText', () => {
  it('returns found:false when text has no json fences', () => {
    const result = findSandboxHandleInText('the agent forgot to emit a handle');
    expect(result.found).toBe(false);
    if (result.found) return;
    expect(result.reason).toMatch(/No ```json code block/);
  });

  it('returns found:true for a single valid handle in fence', () => {
    const text = `here is the handle:\n\`\`\`json\n${JSON.stringify(validHandle, null, 2)}\n\`\`\`\n`;
    const result = findSandboxHandleInText(text);
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.handle.id).toBe('symphony-eng-123');
    expect(result.handle.exec.template).toBe(validHandle.exec.template);
  });

  it('picks the LAST valid handle when multiple appear', () => {
    const earlier = { ...validHandle, id: 'symphony-old' };
    const later = { ...validHandle, id: 'symphony-new' };
    const text = `\`\`\`json\n${JSON.stringify(earlier)}\n\`\`\`\n\nupdated:\n\`\`\`json\n${JSON.stringify(later)}\n\`\`\``;
    const result = findSandboxHandleInText(text);
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.handle.id).toBe('symphony-new');
  });

  it('returns found:false with zod errors when shape is wrong', () => {
    const bad = { id: 'x', kind: 'local-docker' }; // missing fields
    const text = `\`\`\`json\n${JSON.stringify(bad)}\n\`\`\``;
    const result = findSandboxHandleInText(text);
    expect(result.found).toBe(false);
    if (result.found) return;
    expect(result.reason).toMatch(/worktree_path/);
  });

  it('returns found:false when JSON is malformed', () => {
    const text = '```json\n{not valid json}\n```';
    const result = findSandboxHandleInText(text);
    expect(result.found).toBe(false);
    if (result.found) return;
    expect(result.reason).toMatch(/invalid JSON/);
  });

  it('skips malformed blocks and finds a valid one earlier in the text', () => {
    // Later block is malformed, earlier one is valid → we pick the valid earlier one.
    const text = `\`\`\`json\n${JSON.stringify(validHandle)}\n\`\`\`\n\`\`\`json\n{oops}\n\`\`\``;
    const result = findSandboxHandleInText(text);
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.handle.id).toBe('symphony-eng-123');
  });

  it('rejects a SandboxHandle missing exec.template', () => {
    const bad = { ...validHandle, exec: { kind: 'shell-template' } };
    const text = `\`\`\`json\n${JSON.stringify(bad)}\n\`\`\``;
    const result = findSandboxHandleInText(text);
    expect(result.found).toBe(false);
  });
});
