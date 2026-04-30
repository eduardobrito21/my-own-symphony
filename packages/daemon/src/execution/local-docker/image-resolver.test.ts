// Image resolution unit tests — covers all four branches of Plan 10
// step 7 with a fake filesystem stat + a mocked `docker` runner.

import { describe, expect, it } from 'vitest';

import type { DockerResult, DockerRunner } from './docker-runner.js';
import { perProjectTag, resolveImage } from './image-resolver.js';

const ok: DockerResult = { ok: true, exitCode: 0, stdout: '', stderr: '' };
const missing: DockerResult = {
  ok: false,
  exitCode: 1,
  stdout: '',
  stderr: 'No such image',
  signal: null,
};

function mockDocker(presentTags: ReadonlySet<string>): DockerRunner {
  return (args) => {
    if (args[0] === 'image' && args[1] === 'inspect' && typeof args[2] === 'string') {
      return Promise.resolve(presentTags.has(args[2]) ? ok : missing);
    }
    return Promise.reject(new Error(`unexpected docker call: ${args.join(' ')}`));
  };
}

function statMap(files: ReadonlySet<string>): (path: string) => Promise<{ isFile: boolean }> {
  return (path) => Promise.resolve({ isFile: files.has(path) });
}

describe('resolveImage', () => {
  const baseSpec = {
    projectKey: 'edu',
    workspacePath: '/ws',
    baseImage: 'symphony/agent-base:1',
  } as const;

  describe('1. explicit tag wins outright', () => {
    it('returns the explicit tag with source=explicit when present', async () => {
      const result = await resolveImage({
        spec: { ...baseSpec, preferred: 'explicit', explicitTag: 'custom/img:v3' },
        runDocker: mockDocker(new Set(['custom/img:v3'])),
        statFile: statMap(new Set()),
      });
      expect(result).toEqual({
        ok: true,
        value: { tag: 'custom/img:v3', source: 'explicit' },
      });
    });

    it('errors with image_not_found when explicit tag is missing', async () => {
      const result = await resolveImage({
        spec: { ...baseSpec, preferred: 'explicit', explicitTag: 'custom/img:v3' },
        runDocker: mockDocker(new Set()),
        statFile: statMap(new Set()),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('image_not_found');
      expect(result.error.message).toContain('custom/img:v3');
    });
  });

  describe('2. .symphony/agent.dockerfile', () => {
    it('uses the per-project tag when the dockerfile exists', async () => {
      const result = await resolveImage({
        spec: { ...baseSpec, preferred: 'base' },
        runDocker: mockDocker(new Set([perProjectTag('edu')])),
        statFile: statMap(new Set(['/ws/.symphony/agent.dockerfile'])),
      });
      expect(result).toEqual({
        ok: true,
        value: { tag: 'symphony-agent/edu:latest', source: 'repo-dockerfile' },
      });
    });

    it('errors actionable message when per-project tag missing', async () => {
      const result = await resolveImage({
        spec: { ...baseSpec, preferred: 'base' },
        runDocker: mockDocker(new Set()),
        statFile: statMap(new Set(['/ws/.symphony/agent.dockerfile'])),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('image_not_found');
      expect(result.error.message).toContain('pnpm docker:build:edu');
    });
  });

  describe('3. .devcontainer/Dockerfile', () => {
    it('uses per-project tag when devcontainer Dockerfile exists', async () => {
      const result = await resolveImage({
        spec: { ...baseSpec, preferred: 'base' },
        runDocker: mockDocker(new Set([perProjectTag('edu')])),
        statFile: statMap(new Set(['/ws/.devcontainer/Dockerfile'])),
      });
      expect(result).toEqual({
        ok: true,
        value: { tag: 'symphony-agent/edu:latest', source: 'devcontainer' },
      });
    });

    it('prefers .symphony/agent.dockerfile over .devcontainer/Dockerfile', async () => {
      const result = await resolveImage({
        spec: { ...baseSpec, preferred: 'base' },
        runDocker: mockDocker(new Set([perProjectTag('edu')])),
        statFile: statMap(
          new Set(['/ws/.symphony/agent.dockerfile', '/ws/.devcontainer/Dockerfile']),
        ),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.source).toBe('repo-dockerfile');
    });
  });

  describe('4. base fallback', () => {
    it('uses execution.base_image when nothing else matches', async () => {
      const result = await resolveImage({
        spec: { ...baseSpec, preferred: 'base' },
        runDocker: mockDocker(new Set(['symphony/agent-base:1'])),
        statFile: statMap(new Set()),
      });
      expect(result).toEqual({
        ok: true,
        value: { tag: 'symphony/agent-base:1', source: 'base' },
      });
    });

    it('errors with actionable message when the base image is missing', async () => {
      const result = await resolveImage({
        spec: { ...baseSpec, preferred: 'base' },
        runDocker: mockDocker(new Set()),
        statFile: statMap(new Set()),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('image_not_found');
      expect(result.error.message).toContain('pnpm docker:build:agent-base');
    });
  });
});
