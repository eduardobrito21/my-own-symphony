// Image resolution for `LocalDockerBackend`.
//
// Implements the resolution order documented in Plan 10 step 7
// (also referenced by ADR 0009):
//
//   1. Project config sets `agent_image: <tag>`         → use it
//      Error if the tag is not present locally.
//   2. Workspace contains `.symphony/agent.dockerfile`  → expected tag
//      `symphony-agent/<projectKey>:latest`. Operator-built via
//      `pnpm docker:build:<projectKey>`. Error if missing.
//   3. Workspace contains `.devcontainer/Dockerfile`    → same expected
//      tag. Free reuse for repos that already have one.
//   4. Otherwise                                         → fall through
//      to the deployment's `execution.base_image` (default
//      `symphony/agent-base:1`).
//
// "Present locally" is checked via `docker image inspect <tag>`. We
// deliberately do NOT auto-build: the operator runs the right `pnpm
// docker:build:*` script when a missing tag is reported. Auto-build
// has its own design problems (cache invalidation by Dockerfile +
// lockfile hash, build queueing, build-output streaming) that are
// out of scope for v1.

import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { ImageRef, ImageSpec } from '../backend.js';
import type { ExecutionResult } from '../errors.js';

import type { DockerRunner } from './docker-runner.js';

export interface ResolveImageArgs {
  readonly spec: ImageSpec;
  readonly runDocker: DockerRunner;
  /** Test seam — defaults to `node:fs/promises` `stat`. */
  readonly statFile?: (path: string) => Promise<{ isFile: boolean }>;
}

export async function resolveImage(args: ResolveImageArgs): Promise<ExecutionResult<ImageRef>> {
  const { spec, runDocker } = args;
  const statFile = args.statFile ?? defaultStatFile;

  // 1. Explicit project-config tag wins outright. We do NOT walk the
  //    rest of the order: the operator asked for a specific image.
  if (spec.explicitTag !== undefined) {
    const present = await imagePresent(runDocker, spec.explicitTag);
    if (!present) return imageNotFound(spec.explicitTag);
    return ok(spec.explicitTag, 'explicit');
  }

  // 2. Per-repo Dockerfile.
  const repoDockerfile = join(spec.workspacePath, '.symphony', 'agent.dockerfile');
  if ((await statFile(repoDockerfile)).isFile) {
    const tag = perProjectTag(spec.projectKey);
    const present = await imagePresent(runDocker, tag);
    if (!present) {
      return imageNotFound(
        tag,
        `Found ${repoDockerfile} but tag ${tag} is not present locally. ` +
          `Run \`pnpm docker:build:${spec.projectKey}\` and retry.`,
      );
    }
    return ok(tag, 'repo-dockerfile');
  }

  // 3. Devcontainer Dockerfile.
  const devcontainer = join(spec.workspacePath, '.devcontainer', 'Dockerfile');
  if ((await statFile(devcontainer)).isFile) {
    const tag = perProjectTag(spec.projectKey);
    const present = await imagePresent(runDocker, tag);
    if (!present) {
      return imageNotFound(
        tag,
        `Found ${devcontainer} but tag ${tag} is not present locally. ` +
          `Run \`pnpm docker:build:${spec.projectKey}\` (using the devcontainer Dockerfile) and retry.`,
      );
    }
    return ok(tag, 'devcontainer');
  }

  // 4. Base fallback.
  const baseTag = spec.baseImage;
  const present = await imagePresent(runDocker, baseTag);
  if (!present) {
    return imageNotFound(
      baseTag,
      `Base image ${baseTag} is not present locally. Run ` +
        '`pnpm docker:build:agent-base` and retry.',
    );
  }
  return ok(baseTag, 'base');
}

// ---- helpers --------------------------------------------------------

async function imagePresent(runDocker: DockerRunner, tag: string): Promise<boolean> {
  const result = await runDocker(['image', 'inspect', tag]);
  return result.ok;
}

function ok(tag: string, source: ImageRef['source']): { ok: true; value: ImageRef } {
  return { ok: true, value: { tag, source } };
}

function imageNotFound(tag: string, message?: string): ExecutionResult<ImageRef> {
  return {
    ok: false,
    error: {
      code: 'image_not_found',
      tag,
      message:
        message ??
        `Image ${tag} is not present locally. Build it (e.g. \`pnpm docker:build:agent-base\`) and retry.`,
    },
  };
}

/**
 * The tag a per-project derivative image is expected to live under.
 * Format: `symphony-agent/<projectKey>:latest`. Operators are expected
 * to build with `pnpm docker:build:<projectKey>`, which (in a future
 * plan) is a generated script that uses this exact tag.
 */
export function perProjectTag(projectKey: string): string {
  return `symphony-agent/${projectKey}:latest`;
}

async function defaultStatFile(path: string): Promise<{ isFile: boolean }> {
  try {
    const s = await stat(path);
    return { isFile: s.isFile() };
  } catch {
    return { isFile: false };
  }
}
