import { describe, expect, it } from 'vitest';

import { IssueId, IssueIdentifier, SessionId, WorkspaceKey, composeSessionId } from './ids.js';

describe('IssueId / IssueIdentifier / SessionId constructors', () => {
  it('returns the input value branded', () => {
    const id = IssueId('abc-123');
    expect(id).toBe('abc-123');
  });

  it('rejects empty strings', () => {
    expect(() => IssueId('')).toThrow();
    expect(() => IssueIdentifier('')).toThrow();
    expect(() => SessionId('')).toThrow();
  });

  it('does not validate format on IssueId/IssueIdentifier (treats them as opaque)', () => {
    // SPEC §4 leaves the format to the tracker; the constructor only
    // rejects empty strings.
    expect(() => IssueId('any string with / weird @ chars')).not.toThrow();
    expect(() => IssueIdentifier('not-a-typical-pattern')).not.toThrow();
  });
});

describe('WorkspaceKey constructor', () => {
  it('accepts the safe character set', () => {
    expect(() => WorkspaceKey('ABC-123_test.0')).not.toThrow();
  });

  it('rejects unsafe characters (forces use of sanitizeIdentifier)', () => {
    expect(() => WorkspaceKey('with space')).toThrow(/sanitizeIdentifier/);
    expect(() => WorkspaceKey('with/slash')).toThrow();
    expect(() => WorkspaceKey('héllo')).toThrow();
  });

  it('rejects empty string', () => {
    expect(() => WorkspaceKey('')).toThrow();
  });
});

describe('composeSessionId', () => {
  it('produces the spec-mandated `<threadId>-<turnId>` shape', () => {
    expect(composeSessionId('thread-1', 'turn-7')).toBe('thread-1-turn-7');
  });
});
