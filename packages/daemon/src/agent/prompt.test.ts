import { describe, expect, it } from 'vitest';

import { IssueId, IssueIdentifier, ProjectKey, type Issue } from '../types/index.js';

import { parseAndRenderPrompt, parsePromptTemplate, renderPrompt } from './prompt.js';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: IssueId('id-1'),
    identifier: IssueIdentifier('SYMP-1'),
    projectKey: ProjectKey('default'),
    title: 'Fix the bug',
    description: 'A description.',
    priority: 1,
    state: 'In Progress',
    branchName: 'symp-1-fix',
    url: 'https://linear.app/example/issue/SYMP-1',
    labels: ['bug', 'frontend'],
    blockedBy: [],
    createdAt: new Date('2026-04-15T10:00:00Z'),
    updatedAt: null,
    ...overrides,
  };
}

describe('parseAndRenderPrompt', () => {
  it('renders a template with snake_case issue.* placeholders', async () => {
    const result = await parseAndRenderPrompt(
      'Working on {{ issue.identifier }}: {{ issue.title }}.',
      { issue: makeIssue(), attempt: null },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('Working on SYMP-1: Fix the bug.');
    }
  });

  it('exposes labels as a list iterable in templates', async () => {
    const result = await parseAndRenderPrompt('{% for l in issue.labels %}{{ l }};{% endfor %}', {
      issue: makeIssue({ labels: ['bug', 'urgent'] }),
      attempt: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('bug;urgent;');
  });

  it('formats createdAt as an ISO-8601 string', async () => {
    const result = await parseAndRenderPrompt('{{ issue.created_at }}', {
      issue: makeIssue({ createdAt: new Date('2026-04-15T10:00:00Z') }),
      attempt: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('2026-04-15T10:00:00.000Z');
  });

  it('exposes attempt to the template (null on first run)', async () => {
    const first = await parseAndRenderPrompt('attempt={{ attempt }}', {
      issue: makeIssue(),
      attempt: null,
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.value).toBe('attempt=');
  });

  it('lets templates branch on attempt for retry-aware instructions', async () => {
    const template = '{% if attempt == nil %}First run.{% else %}Retry #{{ attempt }}.{% endif %}';
    const first = await parseAndRenderPrompt(template, { issue: makeIssue(), attempt: null });
    const retry = await parseAndRenderPrompt(template, { issue: makeIssue(), attempt: 3 });
    expect(first.ok && first.value).toBe('First run.');
    expect(retry.ok && retry.value).toBe('Retry #3.');
  });

  it('fails rendering on an unknown variable (strictVariables)', async () => {
    const result = await parseAndRenderPrompt('Hello {{ does_not_exist }}.', {
      issue: makeIssue(),
      attempt: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('template_render_error');
  });

  it('fails on an unknown filter (strictFilters; surfaces at parse time)', async () => {
    // liquidjs detects unknown filters statically during parse — it
    // doesn't have to render to know the filter name doesn't resolve.
    // We accept that as a feature: catching the error earlier is
    // strictly better than catching it later.
    const result = await parseAndRenderPrompt('{{ issue.title | nonexistent }}', {
      issue: makeIssue(),
      attempt: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('template_parse_error');
  });

  it('returns template_parse_error on a malformed template', async () => {
    const result = await parseAndRenderPrompt('{% if without_endif %}', {
      issue: makeIssue(),
      attempt: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('template_parse_error');
  });
});

describe('parsePromptTemplate + renderPrompt (cached parse)', () => {
  it('lets callers parse once and render many times', async () => {
    const parsed = parsePromptTemplate('{{ issue.identifier }}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const a = await renderPrompt(parsed.template, {
      issue: makeIssue({ identifier: IssueIdentifier('SYMP-A') }),
      attempt: null,
    });
    const b = await renderPrompt(parsed.template, {
      issue: makeIssue({ identifier: IssueIdentifier('SYMP-B') }),
      attempt: null,
    });
    expect(a.ok && a.value).toBe('SYMP-A');
    expect(b.ok && b.value).toBe('SYMP-B');
  });
});

describe('null-field rendering (locks in liquidjs strictVariables behavior)', () => {
  // Regression: this test fixes the contract that defined-but-null
  // fields render as the empty string under our config. The
  // alternative (throwing) would surprise template authors and break
  // any template that touches a nullable field. Only *missing* keys
  // (e.g. typos) trigger the strict-variable error.

  it('renders null nullable fields as empty strings, not "null"', async () => {
    const result = await parseAndRenderPrompt(
      '|{{ issue.description }}|{{ issue.branch_name }}|{{ issue.url }}|{{ issue.created_at }}|',
      {
        issue: makeIssue({
          description: null,
          branchName: null,
          url: null,
          createdAt: null,
        }),
        attempt: null,
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('|||||');
  });

  it('iterates blocked_by entries with null id/identifier/state without erroring', async () => {
    const result = await parseAndRenderPrompt(
      '{% for b in issue.blocked_by %}<{{ b.identifier }}|{{ b.state }}>{% endfor %}',
      {
        issue: makeIssue({
          blockedBy: [
            { id: null, identifier: null, state: null },
            { id: null, identifier: null, state: 'Done' },
          ],
        }),
        attempt: null,
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('<|><|Done>');
  });

  it('supports the `default:` filter for templates that want explicit fallback text', async () => {
    const result = await parseAndRenderPrompt(
      '{{ issue.description | default: "(no description)" }}',
      { issue: makeIssue({ description: null }), attempt: null },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('(no description)');
  });
});
