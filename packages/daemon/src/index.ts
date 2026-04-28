// Symphony daemon entry point (composition root).
//
// As of Plan 01, this is a CLI that loads a `WORKFLOW.md`, applies defaults,
// resolves env/path indirection, and prints the parsed config + prompt
// template as JSON. Later plans will replace the print with actual scheduling.
//
// Usage:
//
//   symphony [path/to/WORKFLOW.md]
//
// If no path is given, defaults to `./WORKFLOW.md` in the current working
// directory (matches SPEC §5.1 path precedence and the upstream Elixir CLI).
//
// Exit codes:
//   0 — workflow loaded and printed successfully
//   1 — load failed (printed error to stderr)
//   2 — invalid CLI usage

import { resolve } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';

import { formatWorkflowError } from './config/errors.js';
import { loadWorkflow } from './config/loader.js';

async function main(): Promise<number> {
  // argv[0] is `node`, argv[1] is the script path. The first user argument
  // is at index 2. We accept an optional positional path; everything after
  // it is reserved for future flags (Plan 05 will add `--logs-root` etc.).
  const positional = argv.slice(2).filter((arg) => !arg.startsWith('-'));
  if (positional.length > 1) {
    stderr.write(`usage: symphony [path-to-WORKFLOW.md]\n`);
    return 2;
  }

  const workflowPath = resolve(positional[0] ?? './WORKFLOW.md');

  const result = await loadWorkflow(workflowPath);
  if (!result.ok) {
    stderr.write(`${formatWorkflowError(result.error)}\n`);
    return 1;
  }

  // Print the loaded workflow as pretty-printed JSON. This is the Phase 1
  // smoke-test surface — operators can verify their `WORKFLOW.md` is being
  // interpreted as they expect before any scheduling happens.
  stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
  return 0;
}

const code = await main();
exit(code);
