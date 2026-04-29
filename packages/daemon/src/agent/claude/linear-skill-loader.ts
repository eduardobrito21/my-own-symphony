// Load `linear-skill.md` from disk at module-load time.
//
// The skill markdown is the system prompt we hand to the SDK on every
// call (per Plan 07 / sdk-notes.md — system prompt is NOT sticky on
// resume, so we MUST pass it every time). Loading it once at module
// load and exporting a string keeps `ClaudeAgent` simple: it just
// receives the contents.
//
// Why `readFileSync` instead of inlining as a TS constant: the file is
// the canonical source of truth for both humans (it doubles as
// documentation) and the agent. Inlining would require a build-time
// generator step and create a "did you remember to regenerate?" footgun.
//
// Build note: the .md sibling is copied from `src/` into `dist/` by the
// daemon package's `build` script so this resolves under both
// `tsx`-driven dev runs and the built `node dist/index.js` startup
// path. See `packages/daemon/package.json`.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Markdown contents of the Linear skill, loaded once at module init.
 *
 * If the file is missing the import will throw — that's intentional.
 * A daemon configured for `agent.kind: claude` without its skill is
 * mis-deployed and should fail loudly at startup, not yield mute
 * runs.
 */
export const LINEAR_SKILL_MARKDOWN: string = readFileSync(join(HERE, 'linear-skill.md'), 'utf8');
