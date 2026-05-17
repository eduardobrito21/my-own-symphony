// Skill loader — discovers and loads skill definitions.
//
// Per Plan 16 / ADR 0014, skills are markdown files that describe what
// a sub-agent stage does. Discovery order:
//
//   1. `<repo>/.symphony/skills/<name>/SKILL.md` — target repo override
//   2. Bundled default in `packages/daemon/src/skills/<name>/SKILL.md`
//
// The loader reads the SKILL.md file and returns its contents. The
// parent agent reads the skill markdown and executes it via tool calls.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Path to the bundled skills directory (relative to this file's location).
// At runtime this resolves to `packages/daemon/dist/skills/` (built) or
// `packages/daemon/src/skills/` (tsx dev).
const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLED_SKILLS_DIR = join(HERE, '..', '..', 'skills');

/**
 * A loaded skill definition.
 */
export interface SkillDefinition {
  /** Skill name (e.g. 'sandbox', 'coder'). */
  readonly name: string;
  /** Full markdown contents of SKILL.md. */
  readonly markdown: string;
  /** Absolute path where the skill was found. */
  readonly path: string;
  /** Where the skill was loaded from. */
  readonly source: 'repo' | 'bundled';
}

/**
 * Error thrown when a skill cannot be found at any location.
 */
export class SkillNotFoundError extends Error {
  constructor(
    public readonly skillName: string,
    public readonly searchedPaths: string[],
  ) {
    super(
      `Skill '${skillName}' not found. Searched:\n${searchedPaths.map((p) => `  - ${p}`).join('\n')}`,
    );
    this.name = 'SkillNotFoundError';
  }
}

/**
 * Error thrown when a skill file exists but cannot be read.
 */
export class SkillLoadError extends Error {
  public readonly skillName: string;
  public readonly path: string;
  public override readonly cause: Error;

  constructor(skillName: string, path: string, cause: Error) {
    super(`Failed to load skill '${skillName}' from ${path}: ${cause.message}`);
    this.name = 'SkillLoadError';
    this.skillName = skillName;
    this.path = path;
    this.cause = cause;
  }
}

/**
 * Load a skill by name. Searches in order:
 *   1. Repo-side override: `<repoPath>/.symphony/skills/<name>/SKILL.md`
 *   2. Bundled default: `packages/daemon/src/skills/<name>/SKILL.md`
 *
 * @param name - Skill name (e.g. 'sandbox', 'coder')
 * @param repoPath - Path to the cloned repo (null if no repo context)
 * @returns The loaded skill definition
 * @throws {SkillNotFoundError} If the skill is not found at any location
 * @throws {SkillLoadError} If the skill file exists but cannot be read
 */
export async function loadSkill(name: string, repoPath: string | null): Promise<SkillDefinition> {
  const searchedPaths: string[] = [];

  // 1. Try repo-side override
  if (repoPath !== null) {
    const repoSkillPath = join(repoPath, '.symphony', 'skills', name, 'SKILL.md');
    searchedPaths.push(repoSkillPath);

    const repoResult = await tryLoadSkill(name, repoSkillPath, 'repo');
    if (repoResult !== null) {
      return repoResult;
    }
  }

  // 2. Try bundled default
  const bundledSkillPath = join(BUNDLED_SKILLS_DIR, name, 'SKILL.md');
  searchedPaths.push(bundledSkillPath);

  const bundledResult = await tryLoadSkill(name, bundledSkillPath, 'bundled');
  if (bundledResult !== null) {
    return bundledResult;
  }

  // Not found anywhere
  throw new SkillNotFoundError(name, searchedPaths);
}

/**
 * Try to load a skill from a specific path. Returns null if the file
 * doesn't exist, throws SkillLoadError if it exists but can't be read.
 */
async function tryLoadSkill(
  name: string,
  path: string,
  source: 'repo' | 'bundled',
): Promise<SkillDefinition | null> {
  try {
    const markdown = await readFile(path, 'utf8');
    return { name, markdown, path, source };
  } catch (error) {
    // File doesn't exist — not an error, just try next location
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    // File exists but can't be read — that's a real error
    throw new SkillLoadError(name, path, error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Load multiple skills at once. Fails fast on the first missing skill.
 */
export async function loadSkills(
  names: string[],
  repoPath: string | null,
): Promise<Map<string, SkillDefinition>> {
  const skills = new Map<string, SkillDefinition>();
  for (const name of names) {
    const skill = await loadSkill(name, repoPath);
    skills.set(name, skill);
  }
  return skills;
}

/**
 * Get the path where bundled skills are stored. Useful for tests.
 */
export function getBundledSkillsDir(): string {
  return BUNDLED_SKILLS_DIR;
}
