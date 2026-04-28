import { describe, expect, it } from 'vitest';

import { IssueIdentifier } from './ids.js';
import { sanitizeIdentifier } from './sanitize.js';

describe('sanitizeIdentifier', () => {
  it('passes already-safe identifiers through unchanged', () => {
    expect(sanitizeIdentifier(IssueIdentifier('ABC-123'))).toBe('ABC-123');
    expect(sanitizeIdentifier(IssueIdentifier('with.dot_and-hyphen'))).toBe('with.dot_and-hyphen');
  });

  it('replaces whitespace with underscore', () => {
    expect(sanitizeIdentifier(IssueIdentifier('with space'))).toBe('with_space');
    expect(sanitizeIdentifier(IssueIdentifier('tab\there'))).toBe('tab_here');
  });

  it('replaces path separators with underscore (filesystem safety)', () => {
    expect(sanitizeIdentifier(IssueIdentifier('a/b'))).toBe('a_b');
    expect(sanitizeIdentifier(IssueIdentifier('a\\b'))).toBe('a_b');
  });

  it('replaces unicode and special chars', () => {
    expect(sanitizeIdentifier(IssueIdentifier('café'))).toBe('caf_');
    expect(sanitizeIdentifier(IssueIdentifier('emoji🎉here'))).toMatch(/^emoji_+here$/);
  });

  it('replaces every non-safe character class', () => {
    const input = 'A!B@C#D$E%F^G&H*I(J)K=L+M[N]O{P}Q:R;S"T<U>V,W?X|Y~Z`';
    const output = sanitizeIdentifier(IssueIdentifier(input));
    expect(output).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('is idempotent (applying twice = applying once)', () => {
    const once = sanitizeIdentifier(IssueIdentifier('hello world / foo'));
    const twice = sanitizeIdentifier(IssueIdentifier(once));
    expect(twice).toBe(once);
  });
});
