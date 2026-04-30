// In-pod agent runtime entrypoint.
//
// This is the script the docker image's ENTRYPOINT executes. The host
// daemon's `LocalDockerBackend` starts a container with:
//
//   - the per-issue workspace bind-mounted at `/workspace`
//   - this script's dispatch envelope mounted at `/etc/symphony/dispatch.json`
//   - a Unix socket bind-mounted at `/var/run/symphony/events.sock`
//
// Per ADR 0011 + Plan 10, the entrypoint owns the entire work flow
// inside the pod:
//
//   1. Parse + validate the envelope.
//   2. Connect to the host's event socket.
//   3. Fetch the issue from Linear (eligibility check).
//   4. Transition the issue to "In Progress" — the dispatch handshake.
//   5. Clone the repo into /workspace, checkout the per-issue branch.
//   6. Read <workspace>/<workflowPath> for the per-repo workflow.md.
//   7. Render the prompt template against the freshly-fetched issue.
//   8. Construct ClaudeAgent and run query().
//   9. Stream AgentEvents to the socket.
//  10. Exit 0 on terminal event, non-zero on crash.
//
// Errors at every step are reported as a `turn_failed` event to the
// daemon so the orchestrator records them — silent crashes are bugs.

import { spawn } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { env, exit } from 'node:process';

import { ClaudeAgent } from '@symphony/daemon/agent/claude';
import { LINEAR_SKILL_MARKDOWN } from '@symphony/daemon/agent/linear-skill';
import { parsePromptTemplate, renderPrompt } from '@symphony/daemon/agent/prompt';
import type { AgentEvent } from '@symphony/daemon/agent/runner';
import { parseRepoWorkflow, defaultRepoWorkflow } from '@symphony/daemon/config/repo-workflow';
import { createConsoleLogger } from '@symphony/daemon/observability';
import { LinearClient } from '@symphony/daemon/tracker/linear';
import { IssueId, IssueIdentifier, ProjectKey, type Issue } from '@symphony/daemon/types';

import { DispatchEnvelopeSchema, type DispatchEnvelope } from './dispatch-envelope.js';
import {
  fetchIssueById,
  findStateIdByName,
  transitionIssue,
  type FetchedIssue,
} from './linear-helper.js';
import { connectEventSocket, parseEventHost, type EventSocketWriter } from './socket-writer.js';

const ENVELOPE_PATH = '/etc/symphony/dispatch.json';
const WORKSPACE_PATH = '/workspace';
const IN_PROGRESS_STATE = 'In Progress';

async function main(): Promise<number> {
  const logger = createConsoleLogger();

  // ---- Envelope ----
  const envelope = await loadEnvelope();
  if (!envelope.ok) {
    logger.error('failed to load dispatch envelope', { reason: envelope.reason });
    return 2;
  }
  const env_ = envelope.value;

  // ---- Event socket ----
  // The daemon passes its per-pod TCP listener address as
  // `SYMPHONY_EVENT_HOST=host.docker.internal:<port>`. Connect early
  // so a missing/unreachable listener is the first thing we surface.
  const eventHostRaw = env['SYMPHONY_EVENT_HOST'];
  if (eventHostRaw === undefined || eventHostRaw.length === 0) {
    logger.error('SYMPHONY_EVENT_HOST env var missing in pod');
    return 4;
  }
  const eventHost = parseEventHost(eventHostRaw);
  if (eventHost === null) {
    logger.error('SYMPHONY_EVENT_HOST not in expected host:port format', {
      value: eventHostRaw,
    });
    return 4;
  }
  let socket: EventSocketWriter;
  try {
    socket = await connectEventSocket({ host: eventHost.host, port: eventHost.port });
  } catch (cause) {
    logger.error('failed to connect to event socket', {
      host: eventHost.host,
      port: eventHost.port,
      error: stringify(cause),
    });
    return 3;
  }

  // From here on, every failure path emits a terminal event over the
  // socket so the daemon records the dispatch outcome.
  try {
    await runDispatch(env_, socket, logger);
    return 0;
  } catch (cause) {
    logger.error('entrypoint crashed', { error: stringify(cause) });
    await emit(socket, {
      kind: 'turn_failed',
      reason: `entrypoint crashed: ${stringify(cause)}`,
      at: new Date(),
    });
    return 1;
  } finally {
    await socket.close();
  }
}

async function runDispatch(
  envelope: DispatchEnvelope,
  socket: EventSocketWriter,
  logger: ReturnType<typeof createConsoleLogger>,
): Promise<void> {
  const log = logger.with({
    issue_id: envelope.issueId,
    issue_identifier: envelope.issueIdentifier,
    project_key: envelope.projectKey,
  });

  // ---- Linear client ----
  const apiKey = env['LINEAR_API_KEY'];
  if (apiKey === undefined || apiKey.length === 0) {
    await emit(socket, {
      kind: 'turn_failed',
      reason: 'LINEAR_API_KEY env var missing in pod',
      at: new Date(),
    });
    return;
  }
  const linearClient = new LinearClient({
    apiKey,
    endpoint: 'https://api.linear.app/graphql',
  });

  // ---- Eligibility ----
  const fetched = await fetchIssueById(linearClient, envelope.issueId);
  if (!fetched.ok) {
    log.warn('issue fetch failed; exiting "no longer eligible"', { reason: fetched.reason });
    await emit(socket, {
      kind: 'turn_failed',
      reason: `issue fetch failed: ${fetched.reason}`,
      at: new Date(),
    });
    return;
  }
  const fetchedIssue = fetched.issue;

  // ---- Handshake: transition to In Progress ----
  if (fetchedIssue.state.name.toLowerCase() !== IN_PROGRESS_STATE.toLowerCase()) {
    const stateLookup = await findStateIdByName(
      linearClient,
      fetchedIssue.teamId,
      IN_PROGRESS_STATE,
    );
    if (!stateLookup.ok) {
      log.error('cannot transition: state lookup failed', { reason: stateLookup.reason });
      await emit(socket, {
        kind: 'turn_failed',
        reason: `state lookup for "${IN_PROGRESS_STATE}" failed: ${stateLookup.reason}`,
        at: new Date(),
      });
      return;
    }
    const transition = await transitionIssue(linearClient, fetchedIssue.id, stateLookup.stateId);
    if (!transition.ok) {
      log.error('handshake transition failed', { reason: transition.reason });
      await emit(socket, {
        kind: 'turn_failed',
        reason: `handshake transition failed: ${transition.reason}`,
        at: new Date(),
      });
      return;
    }
    log.info('issue transitioned to In Progress (dispatch handshake)');
  }

  // ---- Clone repo + checkout per-issue branch ----
  const cloneResult = await cloneAndCheckout({
    repoUrl: envelope.repo.url,
    defaultBranch: envelope.repo.defaultBranch,
    branchPrefix: envelope.repo.branchPrefix,
    issueIdentifier: envelope.issueIdentifier,
    workspacePath: WORKSPACE_PATH,
  });
  if (!cloneResult.ok) {
    await emit(socket, {
      kind: 'turn_failed',
      reason: `clone/checkout failed: ${cloneResult.reason}`,
      at: new Date(),
    });
    return;
  }
  log.info('repo cloned + branch ready', { branch: cloneResult.branch });

  // ---- Read per-repo workflow.md ----
  const workflowFsPath = join(WORKSPACE_PATH, envelope.repo.workflowPath);
  const repoWorkflow = await loadRepoWorkflowOrDefault(workflowFsPath);

  // ---- Render prompt ----
  const issue = fetchedIssueToDomain(fetchedIssue, envelope.projectKey);
  const parsed = parsePromptTemplate(repoWorkflow.promptTemplate);
  if (!parsed.ok) {
    await emit(socket, {
      kind: 'turn_failed',
      reason: `prompt template parse error: ${parsed.error.message}`,
      at: new Date(),
    });
    return;
  }
  const rendered = await renderPrompt(parsed.template, { issue, attempt: envelope.attempt });
  if (!rendered.ok) {
    await emit(socket, {
      kind: 'turn_failed',
      reason: `prompt render error: ${rendered.message}`,
      at: new Date(),
    });
    return;
  }

  // ---- Resolve effective execution settings ----
  // Per Plan 10: repo-side wins for `model`; `min(operatorCaps, repoCaps)`
  // for budget fields.
  const repoCfg = repoWorkflow.config.agent;
  const opCaps = envelope.operatorCaps;
  const effectiveModel = repoCfg.model ?? opCaps.model;
  const effectiveMaxTurns = minDefined(repoCfg.max_model_round_trips, opCaps.maxTurns);
  const effectiveMaxBudget = minDefined(repoCfg.max_budget_usd, opCaps.maxBudgetUsd);

  log.info('starting agent', {
    model: effectiveModel ?? '<default>',
    max_turns: effectiveMaxTurns ?? null,
    max_budget_usd: effectiveMaxBudget ?? null,
  });

  // ---- Construct + run ClaudeAgent ----
  const agent = new ClaudeAgent({
    linearClient,
    skillMarkdown: LINEAR_SKILL_MARKDOWN,
    logger: log,
    ...(effectiveModel !== undefined && { model: effectiveModel }),
    ...(effectiveMaxTurns !== undefined && { maxModelRoundTrips: effectiveMaxTurns }),
    ...(effectiveMaxBudget !== undefined && { maxBudgetUsd: effectiveMaxBudget }),
  });

  const events = agent.run({
    issueId: IssueId(fetchedIssue.id),
    issueIdentifier: IssueIdentifier(fetchedIssue.identifier),
    workspacePath: WORKSPACE_PATH,
    prompt: rendered.value,
    attempt: envelope.attempt,
  });

  for await (const event of events) {
    await emit(socket, event);
  }
}

// ---------------------------------------------------------------------
// Helpers

async function loadEnvelope(): Promise<
  { ok: true; value: DispatchEnvelope } | { ok: false; reason: string }
> {
  let raw: string;
  try {
    raw = await readFile(ENVELOPE_PATH, 'utf8');
  } catch (cause) {
    return { ok: false, reason: `cannot read ${ENVELOPE_PATH}: ${stringify(cause)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return { ok: false, reason: `${ENVELOPE_PATH} is not valid JSON: ${stringify(cause)}` };
  }
  const validation = DispatchEnvelopeSchema.safeParse(parsed);
  if (!validation.success) {
    return { ok: false, reason: `envelope failed validation: ${validation.error.message}` };
  }
  return { ok: true, value: validation.data };
}

async function loadRepoWorkflowOrDefault(path: string): Promise<{
  promptTemplate: string;
  config: ReturnType<typeof defaultRepoWorkflow>['config'];
}> {
  let exists = false;
  try {
    await stat(path);
    exists = true;
  } catch {
    /* missing — fall through */
  }
  if (!exists) return defaultRepoWorkflow();
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch {
    return defaultRepoWorkflow();
  }
  const parsed = parseRepoWorkflow(content, path);
  if (!parsed.ok) return defaultRepoWorkflow();
  return { promptTemplate: parsed.value.promptTemplate, config: parsed.value.config };
}

interface CloneArgs {
  readonly repoUrl: string;
  readonly defaultBranch: string;
  readonly branchPrefix: string;
  readonly issueIdentifier: string;
  readonly workspacePath: string;
}

async function cloneAndCheckout(
  args: CloneArgs,
): Promise<{ ok: true; branch: string } | { ok: false; reason: string }> {
  const branch = `${args.branchPrefix}${args.issueIdentifier}`;

  // If /workspace already has a .git, skip the clone — daemon restart
  // mid-run reattaches to the same workspace dir and we want this to
  // be a no-op.
  let alreadyCloned = false;
  try {
    await stat(join(args.workspacePath, '.git'));
    alreadyCloned = true;
  } catch {
    /* not yet cloned */
  }

  if (!alreadyCloned) {
    try {
      await mkdir(dirname(args.workspacePath), { recursive: true });
    } catch {
      /* fine — bind-mount may pre-create */
    }
    const clone = await runProcess('git', ['clone', args.repoUrl, args.workspacePath]);
    if (!clone.ok) {
      return { ok: false, reason: `git clone failed: ${clone.stderr.slice(0, 512)}` };
    }
  }

  // Try checkout existing branch, fall back to create.
  const checkout = await runProcess('git', ['checkout', branch], { cwd: args.workspacePath });
  if (!checkout.ok) {
    const create = await runProcess(
      'git',
      ['checkout', '-b', branch, `origin/${args.defaultBranch}`],
      {
        cwd: args.workspacePath,
      },
    );
    if (!create.ok) {
      // Last-ditch: branch off whatever HEAD is.
      const fallback = await runProcess('git', ['checkout', '-b', branch], {
        cwd: args.workspacePath,
      });
      if (!fallback.ok) {
        return {
          ok: false,
          reason: `git checkout -b ${branch} failed: ${fallback.stderr.slice(0, 512)}`,
        };
      }
    }
  }

  return { ok: true, branch };
}

interface ProcResult {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runProcess(
  cmd: string,
  args: readonly string[],
  opts: { readonly cwd?: string } = {},
): Promise<ProcResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args.slice(), {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(opts.cwd !== undefined && { cwd: opts.cwd }),
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => {
      outChunks.push(c);
    });
    child.stderr.on('data', (c: Buffer) => {
      errChunks.push(c);
    });
    child.on('error', (cause) => {
      resolve({
        ok: false,
        exitCode: -1,
        stdout: '',
        stderr: cause instanceof Error ? cause.message : String(cause),
      });
    });
    child.on('close', (code) => {
      resolve({
        ok: code === 0,
        exitCode: code ?? -1,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
      });
    });
  });
}

function fetchedIssueToDomain(raw: FetchedIssue, projectKey: string): Issue {
  return {
    id: IssueId(raw.id),
    identifier: IssueIdentifier(raw.identifier),
    projectKey: ProjectKey(projectKey),
    title: raw.title,
    description: raw.description,
    priority: raw.priority,
    state: raw.state.name,
    branchName: raw.branchName,
    url: raw.url,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  };
}

function emit(socket: EventSocketWriter, event: AgentEvent): Promise<void> {
  return socket.write(event);
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

function stringify(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

const code = await main();
exit(code);
