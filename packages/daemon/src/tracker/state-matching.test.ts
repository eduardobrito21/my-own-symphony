import { describe, expect, it } from 'vitest';

import { isStateAmong, normalizeState } from './state-matching.js';

describe('normalizeState', () => {
  it('lowercases the input', () => {
    expect(normalizeState('In Progress')).toBe('in progress');
    expect(normalizeState('TODO')).toBe('todo');
  });

  it('leaves already-lowercase strings unchanged', () => {
    expect(normalizeState('done')).toBe('done');
  });
});

describe('isStateAmong', () => {
  it('matches case-insensitively', () => {
    expect(isStateAmong('In Progress', ['in progress', 'todo'])).toBe(true);
    expect(isStateAmong('TODO', ['Todo'])).toBe(true);
  });

  it('returns false when no candidate matches', () => {
    expect(isStateAmong('Done', ['Todo', 'In Progress'])).toBe(false);
  });

  it('handles an empty candidate list', () => {
    expect(isStateAmong('Anything', [])).toBe(false);
  });
});
