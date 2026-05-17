// Plan 17a — verify the pipeline prompt surfaces the issue's labels so
// the @sandbox dispatcher skill can read them to pick a backend.

import { describe, expect, it } from 'vitest';

import { IssueId, IssueIdentifier, ProjectKey, type Issue } from '../../types/index.js';
import type { SkillDefinition } from '../skills/index.js';

import { buildPipelinePrompt } from './prompt.js';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: IssueId('id-prompt-1'),
    identifier: IssueIdentifier('EDU-77'),
    projectKey: ProjectKey('default'),
    title: 'Make a thing',
    description: 'Long-form description goes here.',
    priority: null,
    state: 'Todo',
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function skill(name: string, body: string): SkillDefinition {
  return {
    name,
    markdown: body,
    path: `/fake/${name}/SKILL.md`,
    source: 'bundled',
  };
}

function defaultSkills(): Map<string, SkillDefinition> {
  return new Map<string, SkillDefinition>([
    ['sandbox', skill('sandbox', '# sandbox skill body')],
    ['coder', skill('coder', '# coder skill body')],
    ['ci', skill('ci', '# ci skill body')],
  ]);
}

describe('buildPipelinePrompt — label surfacing (Plan 17a)', () => {
  it('renders "Labels: (none)" in the header when the issue has no labels', () => {
    const prompt = buildPipelinePrompt({
      issue: makeIssue({ labels: [] }),
      repoUrl: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      branchPrefix: 'symphony/',
      skills: defaultSkills(),
    });

    expect(prompt).toContain('- Labels: (none)');
  });

  it('joins multiple labels in the header', () => {
    const prompt = buildPipelinePrompt({
      issue: makeIssue({ labels: ['sandbox:namespace', 'priority:high'] }),
      repoUrl: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      branchPrefix: 'symphony/',
      skills: defaultSkills(),
    });

    expect(prompt).toContain('- Labels: sandbox:namespace, priority:high');
  });

  it('echoes labels into the Stage 1 input block so @sandbox sees them inline', () => {
    const prompt = buildPipelinePrompt({
      issue: makeIssue({ labels: ['sandbox:namespace'] }),
      repoUrl: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      branchPrefix: 'symphony/',
      skills: defaultSkills(),
    });

    // The Stage 1 section should mention the label as part of @sandbox's
    // input contract, not just leave it in the header. The dispatcher
    // skill keys off this.
    const stage1Heading = prompt.indexOf('## Stage 1: @sandbox');
    const stage2Heading = prompt.indexOf('## Stage 2: @coder');
    expect(stage1Heading).toBeGreaterThan(0);
    expect(stage2Heading).toBeGreaterThan(stage1Heading);

    const stage1 = prompt.slice(stage1Heading, stage2Heading);
    expect(stage1).toMatch(/- labels: sandbox:namespace/);
    expect(stage1).toMatch(/sandbox:<backend>/);
  });

  it('renders Stage 1 labels as "(none)" when the issue is unlabelled', () => {
    const prompt = buildPipelinePrompt({
      issue: makeIssue({ labels: [] }),
      repoUrl: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      branchPrefix: 'symphony/',
      skills: defaultSkills(),
    });

    const stage1Heading = prompt.indexOf('## Stage 1: @sandbox');
    const stage2Heading = prompt.indexOf('## Stage 2: @coder');
    const stage1 = prompt.slice(stage1Heading, stage2Heading);
    expect(stage1).toMatch(/- labels: \(none\)/);
  });
});

describe('buildPipelinePrompt — MVP @coder + @ci pipeline shape', () => {
  // The MVP @coder + @ci shipped alongside Plan 17a give us a 4-stage
  // pipeline (@sandbox → @coder → @ci? → close-out). These tests pin
  // that shape so Plan 18 / 19 don't accidentally drop stages.

  it('emits four stages in order: sandbox, coder, ci, close-out', () => {
    const prompt = buildPipelinePrompt({
      issue: makeIssue(),
      repoUrl: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      branchPrefix: 'symphony/',
      skills: defaultSkills(),
    });

    const order = [
      '## Stage 1: @sandbox',
      '## Stage 2: @coder',
      '## Stage 3: @ci',
      '## Stage 4: Close Out',
    ];
    let cursor = -1;
    for (const heading of order) {
      const next = prompt.indexOf(heading, cursor + 1);
      expect(
        next,
        `expected to find "${heading}" after position ${String(cursor)}`,
      ).toBeGreaterThan(cursor);
      cursor = next;
    }
  });

  it('tells the agent to skip Stage 3 when @coder returned no changed files', () => {
    const prompt = buildPipelinePrompt({
      issue: makeIssue(),
      repoUrl: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      branchPrefix: 'symphony/',
      skills: defaultSkills(),
    });

    // The Stage 3 section must clearly instruct "skip if empty"; the
    // Stage 2 section must point at the skip path too so the agent
    // doesn't fall through silently.
    expect(prompt).toMatch(/skip[^\n]*Stage 3/i);
    expect(prompt).toMatch(/empty[^\n]*changed_files|changed_files[^\n]*empty/i);
  });

  it('renders the issue URL in the header so Stage 4 can use it in the PR comment', () => {
    const prompt = buildPipelinePrompt({
      issue: makeIssue({ url: 'https://linear.app/example/issue/EDU-77' }),
      repoUrl: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      branchPrefix: 'symphony/',
      skills: defaultSkills(),
    });

    expect(prompt).toContain('- URL: https://linear.app/example/issue/EDU-77');
  });

  it('injects $SKILL_DIR for both @sandbox and @ci sections', () => {
    const prompt = buildPipelinePrompt({
      issue: makeIssue(),
      repoUrl: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      branchPrefix: 'symphony/',
      skills: defaultSkills(),
    });

    // Both skills ship scripts under scripts/; the prompt must give
    // the agent the directory for each so it doesn't have to guess.
    const sandboxHeading = prompt.indexOf('## Stage 1: @sandbox');
    const ciHeading = prompt.indexOf('## Stage 3: @ci');
    expect(sandboxHeading).toBeGreaterThan(0);
    expect(ciHeading).toBeGreaterThan(sandboxHeading);

    const sandboxSection = prompt.slice(sandboxHeading, prompt.indexOf('## Stage 2:'));
    const ciSection = prompt.slice(ciHeading, prompt.indexOf('## Stage 4:'));
    expect(sandboxSection).toMatch(/SKILL_DIR=\/fake\/sandbox/);
    expect(ciSection).toMatch(/SKILL_DIR=\/fake\/ci/);
  });
});
