// Symphony daemon entry point.
//
// This file is the composition root: the only place allowed to wire
// concrete implementations together. It will grow into a CLI that
// loads `WORKFLOW.md`, constructs the orchestrator, and starts the
// polling loop.
//
// For now (Phase 0 / harness bootstrap), it prints a startup banner
// to prove the build pipeline works.

const banner = `
                                  _
                                 | |
  ___ _   _ _ __ ___  _ __ ___   | |__   ___  _ __  _   _
 / __| | | | '_ \` _ \\| '_ \` _ \\  | '_ \\ / _ \\| '_ \\| | | |
 \\__ \\ |_| | | | | | | | | | | | | | | | (_) | | | | |_| |
 |___/\\__, |_| |_| |_|_| |_| |_| |_| |_|\\___/|_| |_|\\__, |
       __/ |                                         __/ |
      |___/                                         |___/

  Symphony — TypeScript reimplementation of openai/symphony
  Status: harness bootstrap (no application logic yet)
  Next:   Plan 01 — workflow loader and config layer
`;

console.log(banner);
