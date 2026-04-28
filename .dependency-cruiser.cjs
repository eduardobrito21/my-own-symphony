/**
 * Mechanical layer-boundary enforcement.
 *
 * Symphony's daemon is decomposed into layers that must depend in one direction
 * only. This file is the source of truth for those rules — if it disagrees with
 * ARCHITECTURE.md, ARCHITECTURE.md is wrong.
 *
 * Error messages are written to be actionable: when a violation fires, the
 * message should tell you (or an agent) how to fix it without reading docs.
 *
 * Layer order (allowed direction is left-to-right):
 *
 *   types -> config -> tracker -> workspace -> agent -> orchestrator -> http -> entry
 *                                  \_____ observability is cross-cutting _____/
 *
 * To run: `pnpm deps:check`
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Circular dependencies make the module graph unanalyzable. Break the cycle by extracting shared code into a lower layer (usually `types/`).',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment:
        'This module is unreachable from any entry point. Either import it from somewhere or delete it.',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)\\.[^/]+\\.(?:js|cjs|mjs|ts|tsx)$',
          '\\.d\\.ts$',
          '(^|/)tsconfig\\.[^/]+\\.json$',
          '(^|/)(jest|babel|webpack|rollup|vite|vitest|tsup|tsconfig)\\.config\\.(?:js|cjs|mjs|ts)$',
          '(^|/)src/index\\.ts$',
        ],
      },
      to: {},
    },
    {
      name: 'types-depends-on-nothing',
      severity: 'error',
      comment:
        '`types/` is the deepest layer — it must not import from any other layer. Move shared logic to a higher layer, or accept that you have a true type that belongs here.',
      from: { path: 'packages/daemon/src/types/' },
      to: {
        path: 'packages/daemon/src/(?!types/)',
        pathNot: 'node_modules',
      },
    },
    {
      name: 'config-only-types',
      severity: 'error',
      comment:
        '`config/` may only depend on `types/`. If you need a runtime helper, lift it into `config/` itself or push the type down into `types/`.',
      from: { path: 'packages/daemon/src/config/' },
      to: {
        path: 'packages/daemon/src/(?!types/|config/)',
        pathNot: 'node_modules',
      },
    },
    {
      name: 'tracker-only-types-config',
      severity: 'error',
      comment:
        '`tracker/` may only depend on `types/` and `config/`. Trackers are leaves — they fetch and normalize, nothing else.',
      from: { path: 'packages/daemon/src/tracker/' },
      to: {
        path: 'packages/daemon/src/(?!types/|config/|tracker/)',
        pathNot: 'node_modules',
      },
    },
    {
      name: 'workspace-only-types-config',
      severity: 'error',
      comment:
        '`workspace/` may only depend on `types/` and `config/`. Workspace management is filesystem-only — it must not know about trackers, agents, or the orchestrator.',
      from: { path: 'packages/daemon/src/workspace/' },
      to: {
        path: 'packages/daemon/src/(?!types/|config/|workspace/)',
        pathNot: 'node_modules',
      },
    },
    {
      name: 'agent-only-types-config-workspace',
      severity: 'error',
      comment:
        '`agent/` may depend on `types/`, `config/`, and `workspace/`. It must not depend on `tracker/` or `orchestrator/` — agent runs are driven by the orchestrator, not the other way around.',
      from: { path: 'packages/daemon/src/agent/' },
      to: {
        path: 'packages/daemon/src/(?!types/|config/|workspace/|agent/)',
        pathNot: 'node_modules',
      },
    },
    {
      name: 'orchestrator-not-from-http',
      severity: 'error',
      comment:
        '`orchestrator/` is the coordination authority and must not depend on `http/`. The HTTP layer adapts the orchestrator to the outside world; reverse dependencies invert the architecture.',
      from: { path: 'packages/daemon/src/orchestrator/' },
      to: { path: 'packages/daemon/src/http/' },
    },
    {
      name: 'http-not-from-anything-but-types-orchestrator-observability',
      severity: 'error',
      comment:
        '`http/` adapts the orchestrator to HTTP. It may depend on `types/`, `orchestrator/`, and `observability/`. It must not reach into `tracker/`, `workspace/`, or `agent/` directly — go through the orchestrator.',
      from: { path: 'packages/daemon/src/http/' },
      to: {
        path: 'packages/daemon/src/(?!types/|orchestrator/|observability/|http/)',
        pathNot: 'node_modules',
      },
    },
  ],
  options: {
    // Only scan TypeScript source under packages/*/src; never the built
    // outputs in dist/.
    includeOnly: '^packages/[^/]+/src/',
    exclude: {
      path: ['node_modules', 'dist', '\\.test\\.ts$', '\\.spec\\.ts$'],
    },
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
