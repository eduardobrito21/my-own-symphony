import { describe, expect, it } from 'vitest';

import { DispatchEnvelopeSchema } from './dispatch-envelope.js';

const valid = {
  issueId: 'id-123',
  issueIdentifier: 'EDU-1',
  projectKey: 'edu',
  tracker: { kind: 'linear', projectSlug: 'edu-slug' },
  repo: {
    url: 'https://example.com/r.git',
    defaultBranch: 'main',
    workflowPath: '.symphony/workflow.md',
    branchPrefix: 'symphony/',
  },
  operatorCaps: { maxTurns: 20 },
  attempt: null,
};

describe('DispatchEnvelopeSchema', () => {
  it('parses a complete valid envelope', () => {
    const result = DispatchEnvelopeSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('parses with operatorCaps fully omitted (still must be present)', () => {
    const result = DispatchEnvelopeSchema.safeParse({ ...valid, operatorCaps: {} });
    expect(result.success).toBe(true);
  });

  it('rejects an envelope missing issueId', () => {
    const { issueId: _omit, ...without } = valid;
    void _omit;
    const result = DispatchEnvelopeSchema.safeParse(without);
    expect(result.success).toBe(false);
  });

  it('rejects an envelope with the wrong tracker kind', () => {
    const result = DispatchEnvelopeSchema.safeParse({
      ...valid,
      tracker: { kind: 'github', projectSlug: 'x' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects extra unknown fields on repo (strict)', () => {
    const result = DispatchEnvelopeSchema.safeParse({
      ...valid,
      repo: { ...valid.repo, weirdField: true },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a positive attempt number', () => {
    const result = DispatchEnvelopeSchema.safeParse({ ...valid, attempt: 3 });
    expect(result.success).toBe(true);
  });

  it('rejects a negative attempt number', () => {
    const result = DispatchEnvelopeSchema.safeParse({ ...valid, attempt: -1 });
    expect(result.success).toBe(false);
  });
});
