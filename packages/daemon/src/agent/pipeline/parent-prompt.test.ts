// Plan 18a — exercise the parent-only orchestration prompt + the
// sub-agent definitions independently.
//
// Pre-18a these were one big inlined prompt; now the parent's
// system prompt is small and the skill bodies live inside the SDK
// `AgentDefinition` for each sub-agent.

import { describe, expect, it } from 'vitest';

import { IssueId, IssueIdentifier, ProjectKey, type Issue } from '../../types/index.js';
import type { SkillDefinition } from '../skills/index.js';

import { buildParentPrompt } from './parent-prompt.js';
import { buildSubAgents, SUB_AGENT_NAMES } from './sub-agents.js';

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
    ['planner', skill('planner', '# planner skill body')],
    ['coder', skill('coder', '# coder skill body')],
    ['ci', skill('ci', '# ci skill body')],
  ]);
}

describe('buildParentPrompt — label surfacing', () => {
  it('renders "Labels: (none)" in the header when the issue has no labels', () => {
    const prompt = buildParentPrompt({
      issue: makeIssue({ labels: [] }),
      repoUrl: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      branchPrefix: 'symphony/',
    });

    expect(prompt).toContain('- Labels: (none)');
  });

  it('joins multiple labels in the header', () => {
    const prompt = buildParentPrompt({
      issue: makeIssue({ labels: ['sandbox:namespace', 'priority:high'] }),
      repoUrl: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      branchPrefix: 'symphony/',
    });

    expect(prompt).toContain('- Labels: sandbox:namespace, priority:high');
  });

  it('threads labels into the Stage 1 dispatch payload so @sandbox sees them', () => {
    const prompt = buildParentPrompt({
      issue: makeIssue({ labels: ['sandbox:namespace'] }),
      repoUrl: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      branchPrefix: 'symphony/',
    });

    const stage1 = prompt.indexOf('## Stage 1 — Dispatch @sandbox');
    const stage2 = prompt.indexOf('## Stage 2 — Dispatch @planner');
    expect(stage1).toBeGreaterThan(0);
    expect(stage2).toBeGreaterThan(stage1);

    const stage1Section = prompt.slice(stage1, stage2);
    expect(stage1Section).toMatch(/- labels: sandbox:namespace/);
  });
});

describe('buildParentPrompt — pipeline shape', () => {
  // The parent prompt pins the 5-stage shape (Plan 20 added @planner
  // between @sandbox and @coder) so future plans don't accidentally
  // drop or reorder stages.

  it('emits the five stages in order', () => {
    const prompt = buildParentPrompt({
      issue: makeIssue(),
      repoUrl: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      branchPrefix: 'symphony/',
    });

    const order = [
      '## Stage 1 — Dispatch @sandbox',
      '## Stage 2 — Dispatch @planner',
      '## Stage 3 — Dispatch @coder',
      '## Stage 4 — Dispatch @ci',
      '## Stage 5 — Close out',
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

  it('tells the agent to skip Stage 4 when @coder returned no changed files', () => {
    const prompt = buildParentPrompt({
      issue: makeIssue(),
      repoUrl: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      branchPrefix: 'symphony/',
    });

    // The orchestration prompt must clearly instruct "skip if empty"
    // so the parent agent never invokes @ci for a no-op @coder run.
    expect(prompt).toMatch(/skip[^\n]*Stage 4/i);
    expect(prompt).toMatch(/empty[^\n]*changed_files|changed_files[^\n]*empty/i);
  });

  it('renders the issue URL in the header so Stage 5 can reference it', () => {
    const prompt = buildParentPrompt({
      issue: makeIssue({ url: 'https://linear.app/example/issue/EDU-77' }),
      repoUrl: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      branchPrefix: 'symphony/',
    });

    expect(prompt).toContain('- URL: https://linear.app/example/issue/EDU-77');
  });

  it('threads plan_path from PlannerResult into the @coder dispatch', () => {
    // Plan 20: @planner runs before @coder and may produce a plan
    // file. The parent prompt must instruct itself to pass plan_path
    // through to @coder so the coder reads the plan as its
    // authoritative instruction.
    const prompt = buildParentPrompt({
      issue: makeIssue(),
      repoUrl: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      branchPrefix: 'symphony/',
    });

    const stage3 = prompt.indexOf('## Stage 3 — Dispatch @coder');
    const stage4 = prompt.indexOf('## Stage 4 — Dispatch @ci');
    expect(stage3).toBeGreaterThan(0);
    expect(stage4).toBeGreaterThan(stage3);
    const stage3Section = prompt.slice(stage3, stage4);
    expect(stage3Section).toMatch(/plan_path/);
  });

  it("does NOT inline any skill body — that's the sub-agents' job now", () => {
    // Plan 18a invariant: the parent prompt should NEVER contain a
    // SKILL.md body (recognizable by skill-internal phrases like
    // "Step 0", or "REQUIRED, do not skip", or the per-skill scripts
    // dir reference). If a sub-agent's prompt leaks back into the
    // parent prompt we're regressing to the pre-18a model.
    const prompt = buildParentPrompt({
      issue: makeIssue(),
      repoUrl: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      branchPrefix: 'symphony/',
    });

    expect(prompt).not.toContain('Step 0 — Pick the backend');
    expect(prompt).not.toContain('SKILL_DIR=');
  });

  it('parent prompt is meaningfully smaller than the pre-18a inlined version', () => {
    // Pre-18a `buildPipelinePrompt` produced ~19k chars on a typical
    // issue (verified live during the Plan 17a smoke). With 18a the
    // parent prompt dropped to a few thousand. Plan 20 added the
    // @planner stage, which adds another ~700 chars. Picking 6.5k
    // as the ceiling: still well below the pre-18a 19k baseline. If
    // this creeps back up further we've started leaking sub-agent
    // content into the parent prompt again.
    const prompt = buildParentPrompt({
      issue: makeIssue({ labels: ['priority:high', 'sandbox:namespace'] }),
      repoUrl: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      branchPrefix: 'symphony/',
    });
    expect(prompt.length).toBeLessThan(6500);
  });
});

describe('buildSubAgents — SDK config', () => {
  // The sub-agent definitions are the load-bearing surface the SDK
  // consumes. Each one needs the right SKILL.md prompt, the right
  // scoped tool list, and a non-empty description (the SDK requires
  // it).

  it('emits one AgentDefinition per known sub-agent', () => {
    const agents = buildSubAgents(defaultSkills());
    expect(Object.keys(agents).sort()).toEqual([...SUB_AGENT_NAMES].sort());
  });

  it('each AgentDefinition has a description, prompt, and tool list', () => {
    const agents = buildSubAgents(defaultSkills());
    for (const name of SUB_AGENT_NAMES) {
      const def = agents[name];
      expect(def, `missing agent definition for ${name}`).toBeDefined();
      if (def === undefined) continue;
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.prompt.length).toBeGreaterThan(0);
      expect(Array.isArray(def.tools)).toBe(true);
    }
  });

  it("@coder gets the editing tool set; @sandbox and @ci don't", () => {
    const agents = buildSubAgents(defaultSkills());
    const coder = agents['coder'];
    const sandbox = agents['sandbox'];
    const ci = agents['ci'];
    expect(coder).toBeDefined();
    expect(sandbox).toBeDefined();
    expect(ci).toBeDefined();
    if (!coder || !sandbox || !ci) return;

    expect(coder.tools).toContain('Edit');
    expect(coder.tools).toContain('Write');
    expect(coder.tools).toContain('Bash');

    expect(sandbox.tools).not.toContain('Edit');
    expect(sandbox.tools).not.toContain('Write');

    expect(ci.tools).not.toContain('Edit');
    expect(ci.tools).not.toContain('Write');
  });

  it('@planner gets Write (to create plan files) but not Edit', () => {
    // Plan 20: planner is a creator, not an editor. It writes new
    // plan files but should NOT edit existing source. Edit lives on
    // @coder. If planner gained Edit it would be tempted to drift
    // into implementation work, which is the wrong stage.
    const agents = buildSubAgents(defaultSkills());
    const planner = agents['planner'];
    expect(planner).toBeDefined();
    if (!planner) return;

    expect(planner.tools).toContain('Write');
    expect(planner.tools).toContain('Bash');
    expect(planner.tools).toContain('Read');
    expect(planner.tools).not.toContain('Edit');
  });

  it('no sub-agent gets the linear_graphql tool — that stays on the parent', () => {
    const agents = buildSubAgents(defaultSkills());
    for (const name of SUB_AGENT_NAMES) {
      const def = agents[name];
      if (def === undefined) continue;
      expect(def.tools, `${name} should not have linear_graphql`).not.toContain(
        'mcp__linear__linear_graphql',
      );
    }
  });

  it("resolves $SKILL_DIR references in SKILL.md to the skill's absolute path", () => {
    // Plan 18a-followup (post EDU-16 smoke): the SDK gives sub-agents
    // a fresh shell per Bash call, so $SKILL_DIR can't survive as an
    // env var. We rewrite the placeholder textually at prompt-build
    // time. The sub-agent ends up with concrete absolute paths in
    // its skill markdown — no shell-variable handling required.
    const skills = new Map<string, SkillDefinition>([
      [
        'sandbox',
        skill(
          'sandbox',
          'Run `bash "$SKILL_DIR/scripts/local-create.sh"` and also `${SKILL_DIR}/scripts/x.sh`.',
        ),
      ],
      ['coder', skill('coder', 'No script refs in @coder.')],
      ['ci', skill('ci', 'Run `bash "$SKILL_DIR/scripts/ci-commit-push-pr.sh"`.')],
    ]);
    const agents = buildSubAgents(skills);

    const sandboxPrompt = agents['sandbox']?.prompt ?? '';
    expect(sandboxPrompt).not.toMatch(/\$\{?SKILL_DIR\}?/);
    expect(sandboxPrompt).toContain('bash "/fake/sandbox/scripts/local-create.sh"');
    expect(sandboxPrompt).toContain('/fake/sandbox/scripts/x.sh');

    const ciPrompt = agents['ci']?.prompt ?? '';
    expect(ciPrompt).not.toMatch(/\$\{?SKILL_DIR\}?/);
    expect(ciPrompt).toContain('bash "/fake/ci/scripts/ci-commit-push-pr.sh"');
  });

  it('includes the full SKILL.md body verbatim in each sub-agent prompt', () => {
    const skills = new Map<string, SkillDefinition>([
      ['sandbox', skill('sandbox', '# sandbox skill body\nsentinel-sb-12345')],
      ['coder', skill('coder', '# coder skill body\nsentinel-co-12345')],
      ['ci', skill('ci', '# ci skill body\nsentinel-ci-12345')],
    ]);
    const agents = buildSubAgents(skills);
    expect(agents['sandbox']?.prompt).toContain('sentinel-sb-12345');
    expect(agents['coder']?.prompt).toContain('sentinel-co-12345');
    expect(agents['ci']?.prompt).toContain('sentinel-ci-12345');
  });
});
