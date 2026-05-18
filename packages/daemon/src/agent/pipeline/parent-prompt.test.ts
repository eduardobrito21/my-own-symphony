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
    ['curator', skill('curator', '# curator skill body')],
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
      escalationLabel: null,
    });

    expect(prompt).toContain('- Labels: (none)');
  });

  it('joins multiple labels in the header', () => {
    const prompt = buildParentPrompt({
      issue: makeIssue({ labels: ['sandbox:namespace', 'priority:high'] }),
      repoUrl: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      branchPrefix: 'symphony/',
      escalationLabel: null,
    });

    expect(prompt).toContain('- Labels: sandbox:namespace, priority:high');
  });

  it('threads labels into the Stage 1 dispatch payload so @sandbox sees them', () => {
    const prompt = buildParentPrompt({
      issue: makeIssue({ labels: ['sandbox:namespace'] }),
      repoUrl: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      branchPrefix: 'symphony/',
      escalationLabel: null,
    });

    const stage1 = prompt.indexOf('## Stage 1 — @sandbox');
    const stage2 = prompt.indexOf('## Stage 2 — @planner');
    expect(stage1).toBeGreaterThan(0);
    expect(stage2).toBeGreaterThan(stage1);

    const stage1Section = prompt.slice(stage1, stage2);
    expect(stage1Section).toMatch(/- labels: sandbox:namespace/);
  });
});

describe('buildParentPrompt — pipeline shape', () => {
  // The parent prompt pins the 7-stage shape (Plan 21 added
  // @env-up + the agentic loop + @env-down + @ci-conditional) so
  // future plans don't accidentally drop or reorder stages.

  it('emits the seven stages in order', () => {
    const prompt = buildParentPrompt({
      issue: makeIssue(),
      repoUrl: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      branchPrefix: 'symphony/',
      escalationLabel: null,
    });

    const order = [
      '## Stage 1 — @sandbox',
      '## Stage 2 — @planner',
      '## Stage 3 — @env-up',
      '## Stage 4 — The agentic loop',
      '## Stage 5 — @env-down',
      '## Stage 6 — @ci',
      '## Stage 7 — Close out',
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

  it('Stage 4 documents the loop algorithm with cap + no-progress checks', () => {
    const prompt = buildParentPrompt({
      issue: makeIssue(),
      repoUrl: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      branchPrefix: 'symphony/',
      escalationLabel: null,
    });

    // The loop must declare its exit conditions explicitly.
    expect(prompt).toMatch(/converged/);
    expect(prompt).toMatch(/cap_hit|cap hit|iter == 3/i);
    expect(prompt).toMatch(/no_progress|no progress/i);
    expect(prompt).toMatch(/fingerprint/);
    // And the iteration mechanic — @coder is re-dispatched with
    // previous-iter findings.
    expect(prompt).toMatch(/previous_findings/);
  });

  it('renders the issue URL in the header so Stage 7 can reference it', () => {
    const prompt = buildParentPrompt({
      issue: makeIssue({ url: 'https://linear.app/example/issue/EDU-77' }),
      repoUrl: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      branchPrefix: 'symphony/',
      escalationLabel: null,
    });

    expect(prompt).toContain('- URL: https://linear.app/example/issue/EDU-77');
  });

  it("threads @curator's flags into the close-out Linear comment", () => {
    // Plan 20 — @curator returns harness-graph findings the operator
    // sees in Linear. If the parent prompt doesn't explicitly tell
    // the agent how to render flags, they vanish silently.
    const prompt = buildParentPrompt({
      issue: makeIssue(),
      repoUrl: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      branchPrefix: 'symphony/',
      escalationLabel: null,
    });

    expect(prompt).toMatch(/Curator findings/);
    // Plan 21: also renders code-review flags in the close-out.
    expect(prompt).toMatch(/Code review findings/);
    expect(prompt).toMatch(/auto_fixes[^.]*do not include/i);
  });

  it('legacy close-out: with null escalationLabel, failures still transition to Done', () => {
    // Back-compat: an operator with no `excluded_labels` config gets
    // the pre-Plan-21 behavior (failures → Done with a failure
    // comment, no label-add).
    const prompt = buildParentPrompt({
      issue: makeIssue(),
      repoUrl: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      branchPrefix: 'symphony/',
      escalationLabel: null,
    });

    // The close-out section should NOT mention issueAddLabel or any
    // escalation branching when escalationLabel is null.
    expect(prompt).not.toMatch(/issueAddLabel/);
    expect(prompt).not.toMatch(/Need Human Help/i);
    expect(prompt).not.toMatch(/Branch A — Success/);
    // It SHOULD still describe the standard Done transition.
    expect(prompt).toMatch(/transition.*Done/i);
    expect(prompt).toMatch(/workflowStates/);
  });

  it('escalation close-out: failures add the configured label and do NOT transition state', () => {
    // Plan 21 escalation pattern: when a pipeline stage fails, the
    // parent agent's close-out adds the operator-configured label
    // (typically "Need Human Help") to the issue and leaves the
    // state alone. The orchestrator's next-tick filter
    // (`linear.excluded_labels`) then skips the issue.
    const prompt = buildParentPrompt({
      issue: makeIssue(),
      repoUrl: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      branchPrefix: 'symphony/',
      escalationLabel: 'Need Human Help',
    });

    // The close-out section gains a failure branch with the label-add.
    expect(prompt).toMatch(/issueAddLabel/);
    expect(prompt).toMatch(/Need Human Help/);
    // The success branch still does the Done transition.
    expect(prompt).toMatch(/Step B — success outcomes/);
    expect(prompt).toMatch(/workflowStates/);
    // Failure branch explicitly says NO state transition.
    expect(prompt).toMatch(/Do NOT transition the issue state/);
    // Fallback documented for missing-label case.
    expect(prompt).toMatch(/FALL BACK to transitioning/);
  });

  it('escalation label name is rendered verbatim in the prompt body', () => {
    // The operator could choose any label name; the prompt threads
    // it through. Test with an unusual name to make sure we don't
    // hardcode "Need Human Help" anywhere.
    const prompt = buildParentPrompt({
      issue: makeIssue(),
      repoUrl: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      branchPrefix: 'symphony/',
      escalationLabel: 'Blocked-By-Symphony',
    });

    expect(prompt).toMatch(/Blocked-By-Symphony/);
    // Negative: an unrelated label name should not leak.
    expect(prompt).not.toMatch(/Need Human Help/);
  });

  it('threads plan_path from PlannerResult into the @coder dispatch (inside the loop)', () => {
    // Plan 20: @planner runs before @coder and may produce a plan
    // file. Plan 21: @coder is now inside the loop. The parent
    // prompt's @coder dispatch (within Stage 4's loop body) must
    // mention plan_path so the agent threads it in on each iter.
    const prompt = buildParentPrompt({
      issue: makeIssue(),
      repoUrl: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      branchPrefix: 'symphony/',
      escalationLabel: null,
    });

    const loopStart = prompt.indexOf('## Stage 4 — The agentic loop');
    const loopEnd = prompt.indexOf('## Stage 5 — @env-down');
    expect(loopStart).toBeGreaterThan(0);
    expect(loopEnd).toBeGreaterThan(loopStart);
    const loopSection = prompt.slice(loopStart, loopEnd);
    expect(loopSection).toMatch(/plan_path/);
    // And the @coder dispatch shape should reference PlannerResult.
    expect(loopSection).toMatch(/PlannerResult\.plan_path/);
  });

  it('includes kind-aware dispatch routing for namespace backends', () => {
    // After @sandbox returns, the parent must branch on
    // SandboxHandle.kind. Local kinds use the Agent tool (Plan 18a
    // path, unchanged); namespace-devbox kinds shell out via Bash
    // to the in-VM wrapper. Both must be documented in the prompt.
    const prompt = buildParentPrompt({
      issue: makeIssue(),
      repoUrl: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      branchPrefix: 'symphony/',
      escalationLabel: null,
    });

    expect(prompt).toMatch(/How to dispatch a sub-agent/);
    expect(prompt).toMatch(/kind.*starts with.*local-/i);
    expect(prompt).toMatch(/namespace-devbox/);
    expect(prompt).toMatch(/nsc ssh/);
    expect(prompt).toMatch(/\/opt\/symphony\/dispatch\.sh/);
    // Plan 18c — bare microVM: no --container_name anywhere.
    expect(prompt).not.toMatch(/--container_name/);
    // Secrets ride stdin: printf assembles env, env vars expand inside
    // double-quoted printf args.
    expect(prompt).toMatch(/printf 'ANTHROPIC_API_KEY=/);
    expect(prompt).toMatch(/"\$ANTHROPIC_API_KEY"/);
    expect(prompt).toMatch(/"\$GITHUB_TOKEN"/);
    // Inputs ride stdin: single-quoted heredoc shields user content
    // (apostrophes, backticks, dollars) from shell parsing.
    expect(prompt).toMatch(/<<'SYMPHONY_INPUTS_EOF'/);
    expect(prompt).toMatch(/---SYMPHONY-INPUTS---/);
    expect(prompt).not.toMatch(/INPUTS_JSON/);
  });

  it('warns the parent agent NOT to echo secret values (Plan 18c)', () => {
    // The dispatch template references `$ANTHROPIC_API_KEY` and
    // `$GITHUB_TOKEN` as literal shell-variable tokens — those
    // resolve inside the Bash tool's shell, not in the agent's
    // narrative output. If the agent ever inlines the resolved
    // values (e.g., to "show" the dispatch command in chat), the
    // secrets leak. The prompt explicitly forbids it.
    const prompt = buildParentPrompt({
      issue: makeIssue(),
      repoUrl: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      branchPrefix: 'symphony/',
      escalationLabel: null,
    });

    expect(prompt).toMatch(/secret hygiene/i);
    expect(prompt).toMatch(/do NOT[^.]*(echo|quote|log)/i);
  });

  it('describes both dispatch modes in ONE routing block, not per-stage (Plan 22)', () => {
    // Plan 22 invariant: the local-* vs namespace-devbox dispatch
    // choice is documented exactly once, in the "How to dispatch a
    // sub-agent" section after Stage 1. Per-stage sections (Stages
    // 2-6 + the four loop-step sensors inside Stage 4) carry inputs
    // only — no "For `local-*`:" / "For `namespace-devbox`:"
    // duplication. Regression guard: cap occurrences of each marker.
    const prompt = buildParentPrompt({
      issue: makeIssue(),
      repoUrl: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      branchPrefix: 'symphony/',
      escalationLabel: null,
    });

    // Both modes still appear in the prompt — just in the routing
    // block, not per-stage. (Match "**`kind` starts with `local-`**"
    // and "**`kind` is `namespace-devbox`**".)
    expect(prompt).toMatch(/`kind` starts with `local-/);
    expect(prompt).toMatch(/`kind` is `namespace-devbox`/);

    // And the pre-Plan-22 per-stage duplication is GONE: no
    // "For `local-" / "For `namespace-devbox`" markers should
    // appear (those headed the per-stage branches before).
    expect(prompt).not.toMatch(/For `?local-/);
    expect(prompt).not.toMatch(/For `?namespace-devbox/);
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
      escalationLabel: null,
    });

    expect(prompt).not.toContain('Step 0 — Pick the backend');
    expect(prompt).not.toContain('SKILL_DIR=');
  });

  it('parent prompt is compressed per Plan 22 (≤ 11k chars on a typical issue)', () => {
    // Plan 22 (2026-05-18) compressed the prompt by collapsing the
    // per-stage local-* vs namespace-devbox duplication into a
    // single "How to dispatch a sub-agent" block and trimming the
    // dispatch-template explainer. Pre-Plan-22 size was ~17k.
    //
    // Two production paths: with-escalation-label (the configured
    // production case; longer because it carries two Step B
    // branches) and null-escalation (legacy path; ~9.6k). The
    // budget here is the with-escalation case (post-22 ~10.5k).
    // If a future plan adds a stage and bumps this, that's the
    // trigger to re-examine the structure — not to bump the budget.
    const promptEscalation = buildParentPrompt({
      issue: makeIssue({ labels: ['priority:high', 'sandbox:namespace'] }),
      repoUrl: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      branchPrefix: 'symphony/',
      escalationLabel: 'Need Human Help',
    });
    expect(promptEscalation.length).toBeLessThan(11000);

    const promptLegacy = buildParentPrompt({
      issue: makeIssue({ labels: ['priority:high', 'sandbox:namespace'] }),
      repoUrl: 'https://github.com/example/repo.git',
      defaultBranch: 'main',
      branchPrefix: 'symphony/',
      escalationLabel: null,
    });
    // Legacy path is materially smaller (no failure-branch prose).
    expect(promptLegacy.length).toBeLessThan(10000);
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

  it('@curator gets Edit and Write (auto-fix harness drift in place)', () => {
    // Plan 20 curator: unlike @planner (creator-only) or @ci
    // (read-only), the curator needs to mutate existing files —
    // stamping frontmatter, adding entries to indexes, fixing typo
    // cross-references. Both Edit (for in-place changes) and Write
    // (for less common cases like creating a missing index.md) are
    // required. Bash is also needed for `git diff`.
    const agents = buildSubAgents(defaultSkills());
    const curator = agents['curator'];
    expect(curator).toBeDefined();
    if (!curator) return;

    expect(curator.tools).toContain('Edit');
    expect(curator.tools).toContain('Write');
    expect(curator.tools).toContain('Bash');
    expect(curator.tools).toContain('Read');
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
    // The SDK gives sub-agents a fresh shell per Bash call, so
    // $SKILL_DIR can't survive as an env var. We rewrite the
    // placeholder textually at prompt-build time so the sub-agent
    // sees concrete absolute paths in its skill markdown.
    const skills = new Map<string, SkillDefinition>([
      [
        'sandbox',
        skill(
          'sandbox',
          'Run `bash "$SKILL_DIR/scripts/local-create.sh"` and also `${SKILL_DIR}/scripts/x.sh`.',
        ),
      ],
      ['planner', skill('planner', 'No script refs in @planner.')],
      ['coder', skill('coder', 'No script refs in @coder.')],
      ['curator', skill('curator', 'No script refs in @curator.')],
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
      ['planner', skill('planner', '# planner skill body\nsentinel-pl-12345')],
      ['coder', skill('coder', '# coder skill body\nsentinel-co-12345')],
      ['curator', skill('curator', '# curator skill body\nsentinel-cu-12345')],
      ['ci', skill('ci', '# ci skill body\nsentinel-ci-12345')],
    ]);
    const agents = buildSubAgents(skills);
    expect(agents['sandbox']?.prompt).toContain('sentinel-sb-12345');
    expect(agents['planner']?.prompt).toContain('sentinel-pl-12345');
    expect(agents['coder']?.prompt).toContain('sentinel-co-12345');
    expect(agents['curator']?.prompt).toContain('sentinel-cu-12345');
    expect(agents['ci']?.prompt).toContain('sentinel-ci-12345');
  });
});
