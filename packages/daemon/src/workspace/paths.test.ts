import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { IssueIdentifier } from '../types/index.js';

import { assertContained, workspacePathFor } from './paths.js';

const ROOT = '/tmp/symphony-ws-paths-test';

describe('workspacePathFor', () => {
  it('produces an absolute path under the root', () => {
    const path = workspacePathFor(ROOT, IssueIdentifier('SYMP-1'));
    expect(path).toBe(`${ROOT}/SYMP-1`);
  });

  it('sanitizes unsafe characters in the identifier', () => {
    const path = workspacePathFor(ROOT, IssueIdentifier('SYMP/1 with space'));
    expect(path).toBe(`${ROOT}/SYMP_1_with_space`);
  });

  it('absolutizes a relative root before resolving', () => {
    // We don't care about the exact result; only that it's absolute
    // and inside the resolved root.
    const path = workspacePathFor('relative-root', IssueIdentifier('SYMP-1'));
    expect(path.startsWith('/')).toBe(true);
    expect(path.endsWith('/SYMP-1')).toBe(true);
  });

  it('handles a root that contains ~ correctly when given to it expanded', () => {
    const path = workspacePathFor(join(homedir(), 'symphony'), IssueIdentifier('SYMP-1'));
    expect(path).toBe(`${homedir()}/symphony/SYMP-1`);
  });
});

describe('assertContained', () => {
  it('passes when candidate is a child of root', () => {
    expect(() => {
      assertContained('/tmp/root', '/tmp/root/child');
    }).not.toThrow();
    expect(() => {
      assertContained('/tmp/root', '/tmp/root/child/nested');
    }).not.toThrow();
  });

  it('throws when candidate is the root itself (no key portion)', () => {
    expect(() => {
      assertContained('/tmp/root', '/tmp/root/..');
    }).toThrow();
  });

  it('throws when candidate uses .. to escape', () => {
    expect(() => {
      assertContained('/tmp/root', '/tmp/root/../sibling');
    }).toThrow();
  });

  it('throws when candidate is a sibling of root', () => {
    expect(() => {
      assertContained('/tmp/root', '/tmp/sibling');
    }).toThrow();
  });

  it('throws an exception carrying a workspace_containment payload', () => {
    try {
      assertContained('/tmp/root', '/etc/passwd');
      expect.fail('expected throw');
    } catch (caught) {
      // The exception is a real Error (so `instanceof Error` keeps
      // working) that carries the typed payload under `.payload`.
      expect(caught).toBeInstanceOf(Error);
      expect((caught as { payload: unknown }).payload).toMatchObject({
        code: 'workspace_containment',
        root: '/tmp/root',
        candidate: '/etc/passwd',
      });
    }
  });
});
