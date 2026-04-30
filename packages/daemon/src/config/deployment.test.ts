import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

import { buildDeploymentConfigSchema } from './deployment.js';
import { loadDeployment } from './deployment-loader.js';

describe('buildDeploymentConfigSchema', () => {
  it('parses a minimal one-project deployment with all defaults', () => {
    const schema = buildDeploymentConfigSchema('/tmp/dep');
    const result = schema.safeParse({
      projects: [
        {
          linear: { project_slug: 'abc' },
          repo: { url: 'https://github.com/o/r.git' },
        },
      ],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const config = result.data;
    expect(config.polling.interval_ms).toBe(30_000);
    expect(config.execution.backend).toBe('local-docker');
    expect(config.execution.base_image).toBe('symphony/agent-base:1');
    expect(config.agent.model).toBe('claude-haiku-4-5');
    expect(config.agent.max_concurrent_agents).toBe(10);
    expect(config.projects).toHaveLength(1);
    expect(config.projects[0]?.repo.default_branch).toBe('main');
    expect(config.projects[0]?.repo.workflow_path).toBe('.symphony/workflow.md');
    expect(config.projects[0]?.repo.branch_prefix).toBe('symphony/');
  });

  it('parses a multi-project deployment with overrides', () => {
    const schema = buildDeploymentConfigSchema('/tmp/dep');
    const result = schema.safeParse({
      polling: { interval_ms: 10_000 },
      execution: { backend: 'in-process', base_image: 'symphony/agent-base:2' },
      projects: [
        {
          linear: { project_slug: 'edu' },
          repo: {
            url: 'https://github.com/eduardobrito/my-own-symphony.git',
            default_branch: 'main',
            agent_image: 'symphony-agent/symphony:latest',
          },
        },
        {
          linear: { project_slug: 'mkt' },
          repo: {
            url: 'https://github.com/eduardobrito/marketing-site.git',
            default_branch: 'production',
            branch_prefix: 'mkt/',
          },
        },
      ],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.polling.interval_ms).toBe(10_000);
    expect(result.data.execution.backend).toBe('in-process');
    expect(result.data.projects).toHaveLength(2);
    expect(result.data.projects[0]?.repo.agent_image).toBe('symphony-agent/symphony:latest');
    expect(result.data.projects[1]?.repo.branch_prefix).toBe('mkt/');
  });

  it('rejects an empty projects array', () => {
    const schema = buildDeploymentConfigSchema('/tmp/dep');
    const result = schema.safeParse({ projects: [] });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.path.join('.') === 'projects')).toBe(true);
  });

  it('rejects a project entry missing repo.url', () => {
    const schema = buildDeploymentConfigSchema('/tmp/dep');
    const result = schema.safeParse({
      projects: [{ linear: { project_slug: 'x' }, repo: {} }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys inside known sections', () => {
    const schema = buildDeploymentConfigSchema('/tmp/dep');
    const result = schema.safeParse({
      polling: { interval_ms: 10_000, intterval_ms: 999 }, // typo
      projects: [
        {
          linear: { project_slug: 'a' },
          repo: { url: 'https://github.com/o/r.git' },
        },
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    // zod surfaces unknown keys via the `unrecognized_keys` code with
    // the offending names in `.keys`, not in `.path` (which points
    // at the parent section).
    expect(
      result.error.issues.some(
        (i) =>
          i.code === 'unrecognized_keys' &&
          (i as { keys?: string[] }).keys?.includes('intterval_ms'),
      ),
    ).toBe(true);
  });

  it('rejects an invalid execution.backend enum value', () => {
    const schema = buildDeploymentConfigSchema('/tmp/dep');
    const result = schema.safeParse({
      execution: { backend: 'kubernetes' },
      projects: [
        {
          linear: { project_slug: 'a' },
          repo: { url: 'https://github.com/o/r.git' },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('passes through unknown TOP-level keys (forward compat)', () => {
    const schema = buildDeploymentConfigSchema('/tmp/dep');
    const result = schema.safeParse({
      observability: { exporter: 'otlp' },
      projects: [
        {
          linear: { project_slug: 'a' },
          repo: { url: 'https://github.com/o/r.git' },
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe('loadDeployment', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'symphony-deployment-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns missing_workflow_file when the file does not exist', async () => {
    const result = await loadDeployment(join(tempDir, 'nope.yaml'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('missing_workflow_file');
  });

  it('loads a one-project deployment from disk', async () => {
    const path = join(tempDir, 'symphony.yaml');
    await writeFile(
      path,
      [
        'projects:',
        '  - linear:',
        '      project_slug: abc',
        '    repo:',
        '      url: https://github.com/o/r.git',
        '',
      ].join('\n'),
    );
    const result = await loadDeployment(path);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.path).toBe(path);
    expect(result.value.config.projects).toHaveLength(1);
    expect(result.value.config.projects[0]?.linear.project_slug).toBe('abc');
  });

  it('returns workflow_parse_error on malformed YAML', async () => {
    const path = join(tempDir, 'bad.yaml');
    await writeFile(path, 'projects:\n  - linear:\n    project_slug: [unclosed\n');
    const result = await loadDeployment(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('workflow_parse_error');
  });

  it('returns workflow_front_matter_not_a_map when YAML is a list at root', async () => {
    const path = join(tempDir, 'list.yaml');
    await writeFile(path, '- a\n- b\n');
    const result = await loadDeployment(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('workflow_front_matter_not_a_map');
      if (result.error.code === 'workflow_front_matter_not_a_map') {
        expect(result.error.actualType).toBe('array');
      }
    }
  });

  it('returns workflow_validation_error when projects is empty', async () => {
    const path = join(tempDir, 'empty-projects.yaml');
    await writeFile(path, 'projects: []\n');
    const result = await loadDeployment(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('workflow_validation_error');
  });

  it('parses the example template at examples/deployment/symphony.yaml', async () => {
    // The example file has a placeholder `REPLACE_WITH_...` for the
    // project slug; it's still a valid string so the schema should
    // accept it. This guards against accidentally breaking the
    // documented operator-onboarding template.
    const examplePath = join(HERE, '../../../../examples/deployment/symphony.yaml');
    const result = await loadDeployment(examplePath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config.projects.length).toBeGreaterThanOrEqual(1);
  });
});
