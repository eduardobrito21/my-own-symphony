// Path and environment-variable resolution helpers.
//
// SPEC §6.1 prescribes a specific resolution pipeline for config values:
//   - `~` is expanded to the user's home directory for path-shaped values.
//   - `$VAR_NAME` is resolved against `process.env` only when a value
//     explicitly contains that form. We do NOT globally substitute env
//     references inside arbitrary strings (URLs, shell commands).
//   - Relative paths resolve against the directory containing `WORKFLOW.md`,
//     not the current working directory.
//
// Each helper here does exactly one of those steps. The schema layer
// composes them via `z.transform` for the fields where they apply.

import { homedir } from 'node:os';
import { isAbsolute, resolve as pathResolve } from 'node:path';

/**
 * Match strings of the form `$VAR_NAME` (entire string is one env reference).
 *
 * We match the whole input because SPEC §6.1 says env references are not
 * substitutions inside arbitrary strings — only top-level placeholders.
 * `$FOO/bar` is treated as a literal path, not as `${process.env.FOO}/bar`.
 */
const ENV_REF_PATTERN = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;

/**
 * Replace a leading `~` with the current user's home directory.
 *
 * Intentionally narrow: we expand only `~` as the first segment. `~user`
 * (other-user expansion) is not supported because Node's `os.homedir()`
 * does not provide that, and resolving it correctly requires a passwd
 * lookup that is OS-specific.
 */
export function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return `${homedir()}/${value.slice(2)}`;
  return value;
}

/**
 * Resolve a `$VAR_NAME` reference to the corresponding environment value.
 *
 * Returns `undefined` when:
 *   - The input is not an env reference (caller should treat as a literal).
 *   - The referenced variable is unset.
 *   - The referenced variable is the empty string. SPEC §5.3.1 explicitly
 *     says an empty resolution must be treated as missing for `tracker.api_key`,
 *     and we apply the same rule everywhere for consistency.
 *
 * Returns the literal string unchanged when it is not an env reference.
 */
export function resolveEnvVar(value: string): string | undefined {
  const match = ENV_REF_PATTERN.exec(value);
  if (match === null) return value;
  const varName = match[1];
  if (varName === undefined) return value;
  const resolved = process.env[varName];
  if (resolved === undefined || resolved === '') return undefined;
  return resolved;
}

/**
 * Make a path absolute, resolving relative paths against `baseDir`.
 *
 * Per SPEC §5.3.3, the `baseDir` for `workspace.root` is the directory
 * containing the workflow file — NOT `process.cwd()`. This matters because
 * the daemon may be launched from anywhere; configs must remain stable
 * regardless of where you run from.
 */
export function absolutize(path: string, baseDir: string): string {
  if (isAbsolute(path)) return path;
  return pathResolve(baseDir, path);
}

/**
 * Resolve a path-shaped config value through the full pipeline:
 *   1. If it is `$VAR`, replace with env value (or treat as missing).
 *   2. Expand a leading `~` to the home directory.
 *   3. If still relative, resolve against `baseDir`.
 *
 * Used for `workspace.root`. `tracker.api_key` runs only step 1.
 */
export function resolvePath(value: string, baseDir: string): string | undefined {
  const envResolved = resolveEnvVar(value);
  if (envResolved === undefined) return undefined;
  const homeExpanded = expandHome(envResolved);
  return absolutize(homeExpanded, baseDir);
}
