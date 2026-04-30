'use client';

// Symphony dashboard — overview page.
//
// One screen, three panels: running, retrying, totals. Auto-refreshes
// every 2s by polling the daemon's `/api/v1/state`. Read-only —
// nothing on this page can mutate the orchestrator.
//
// Plan 08b (the "basic working version" the user requested). The
// fancier views (per-issue timeline, recent failures, cost charts)
// belong in a follow-up once we have an event-buffer story.

import type { ReactNode } from 'react';

import type {
  ProjectSnapshotWire,
  RetryEntryWire,
  RunningEntryWire,
  StateSnapshotWire,
} from './api-types';
import { formatDuration, formatTimestamp, formatTokens } from './format';
import { useSnapshot } from './use-snapshot';

export default function Page(): ReactNode {
  const { snapshot, error, lastFetchedAt } = useSnapshot();

  return (
    <div className="app">
      <header className="header">
        <h1>Symphony</h1>
        <div className="meta">
          {snapshot === null ? (
            'connecting…'
          ) : (
            <>
              {renderHealth(error)}
              <span style={{ marginLeft: 8 }}>
                · uptime {formatUptime(snapshot)} · poll {String(snapshot.pollIntervalMs / 1000)}s
              </span>
            </>
          )}
          {lastFetchedAt !== null && (
            <span style={{ marginLeft: 12 }}>
              last sync {formatTimestamp(lastFetchedAt.toISOString())}
            </span>
          )}
        </div>
      </header>

      {error !== null && (
        <div className="error-banner">
          can&apos;t reach daemon: {error}
          {snapshot !== null && ' (showing last known state)'}
        </div>
      )}

      <div className="grid">
        <div>
          <RunningPanel snapshot={snapshot} />
          <div style={{ height: 16 }} />
          <RetryingPanel snapshot={snapshot} />
        </div>
        <div>
          <ProjectsPanel snapshot={snapshot} />
          <div style={{ height: 16 }} />
          <TotalsPanel snapshot={snapshot} />
          <div style={{ height: 16 }} />
          <CompletedPanel snapshot={snapshot} />
        </div>
      </div>
    </div>
  );
}

// ---- Projects panel (Plan 09c) --------------------------------------

function ProjectsPanel({ snapshot }: { snapshot: StateSnapshotWire | null }): ReactNode {
  const projects = snapshot?.projects ?? [];
  // Single-project deployments don't add value with a "1 project,
  // shows everything" panel, so we collapse it to nothing in that
  // case. Keep the panel for multi-project + when explicitly empty
  // (debugging "is the snapshot wired?").
  if (projects.length <= 1) return null;
  return (
    <div className="panel">
      <div className="panel-header">
        <span>projects</span>
        <span className="count">{projects.length}</span>
      </div>
      <div className="panel-body">
        {projects.map((p) => (
          <ProjectRow key={p.projectKey} project={p} />
        ))}
      </div>
    </div>
  );
}

function ProjectRow({ project }: { project: ProjectSnapshotWire }): ReactNode {
  return (
    <div className="row">
      <div className="top">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="id">{project.projectKey}</div>
        </div>
      </div>
      <div className="meta">
        <span>running {project.running}</span>
        <span>retrying {project.retrying}</span>
        <span>completed {project.completed}</span>
      </div>
    </div>
  );
}

// ---- Panels ----------------------------------------------------------

function RunningPanel({ snapshot }: { snapshot: StateSnapshotWire | null }): ReactNode {
  const rows = snapshot?.running ?? [];
  return (
    <div className="panel">
      <div className="panel-header">
        <span>running</span>
        <span className="count">
          {rows.length} / {snapshot?.maxConcurrentAgents ?? '-'}
        </span>
      </div>
      <div className="panel-body">
        {rows.length === 0 && <div className="empty">no agents running</div>}
        {rows.map((entry) => (
          <RunningRow key={entry.id} entry={entry} now={snapshot?.now ?? null} />
        ))}
      </div>
    </div>
  );
}

function RunningRow({ entry, now }: { entry: RunningEntryWire; now: string | null }): ReactNode {
  const sinceMs = now === null ? 0 : new Date(now).getTime() - new Date(entry.startedAt).getTime();
  return (
    <div className="row">
      <div className="top">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="id">
            {entry.issue.url !== null ? (
              <a href={entry.issue.url} target="_blank" rel="noopener noreferrer">
                {entry.issue.identifier}
              </a>
            ) : (
              entry.issue.identifier
            )}
          </div>
          <div className="title">{entry.issue.title}</div>
        </div>
      </div>
      <div className="meta">
        <span className="badge">{entry.issue.state}</span>
        {entry.issue.projectKey !== 'default' && (
          <span className="badge">{entry.issue.projectKey}</span>
        )}
        <span>turn {entry.session.turnCount}</span>
        <span>started {formatDuration(sinceMs)} ago</span>
        <span>{formatTokens(entry.session.tokens.totalTokens)} tok</span>
        {entry.retryAttempt !== null && <span>attempt {entry.retryAttempt}</span>}
      </div>
      {entry.session.lastAgentMessage !== null && (
        <div className="last-msg">▸ {entry.session.lastAgentMessage}</div>
      )}
    </div>
  );
}

function RetryingPanel({ snapshot }: { snapshot: StateSnapshotWire | null }): ReactNode {
  const rows = snapshot?.retryAttempts ?? [];
  return (
    <div className="panel">
      <div className="panel-header">
        <span>retrying</span>
        <span className="count">{rows.length}</span>
      </div>
      <div className="panel-body">
        {rows.length === 0 && <div className="empty">no retries pending</div>}
        {rows.map((entry) => (
          <RetryRow key={entry.id} entry={entry} />
        ))}
      </div>
    </div>
  );
}

function RetryRow({ entry }: { entry: RetryEntryWire }): ReactNode {
  return (
    <div className="row">
      <div className="top">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="id">{entry.identifier}</div>
        </div>
      </div>
      <div className="meta">
        <span>attempt {entry.attempt}</span>
        <span>fires in {formatDuration(entry.dueInMs)}</span>
        {entry.error !== null && <span className="badge">{entry.error}</span>}
      </div>
    </div>
  );
}

function TotalsPanel({ snapshot }: { snapshot: StateSnapshotWire | null }): ReactNode {
  const totals = snapshot?.agentTotals;
  return (
    <div className="panel">
      <div className="panel-header">
        <span>totals (this run)</span>
      </div>
      <div className="totals">
        <div className="total">
          <span className="label">input tokens</span>
          <span className="value">
            {totals === undefined ? '-' : formatTokens(totals.inputTokens)}
          </span>
        </div>
        <div className="total">
          <span className="label">output tokens</span>
          <span className="value">
            {totals === undefined ? '-' : formatTokens(totals.outputTokens)}
          </span>
        </div>
        <div className="total">
          <span className="label">total tokens</span>
          <span className="value">
            {totals === undefined ? '-' : formatTokens(totals.totalTokens)}
          </span>
        </div>
        <div className="total">
          <span className="label">agent runtime</span>
          <span className="value">
            {totals === undefined ? '-' : formatDuration(totals.secondsRunning * 1000)}
          </span>
        </div>
      </div>
    </div>
  );
}

function CompletedPanel({ snapshot }: { snapshot: StateSnapshotWire | null }): ReactNode {
  const ids = snapshot?.completed ?? [];
  // The wire shape doesn't carry full Issue data for completed
  // entries (the running map has dropped them). We show the count
  // + last few IDs so you know progress is happening.
  return (
    <div className="panel">
      <div className="panel-header">
        <span>completed (this run)</span>
        <span className="count">{ids.length}</span>
      </div>
      <div className="panel-body">
        {ids.length === 0 && <div className="empty">none yet</div>}
        {ids.length > 0 && (
          <div className="row">
            <div className="meta" style={{ flexWrap: 'wrap' }}>
              {ids.slice(-12).map((id) => (
                <span key={id} className="badge">
                  {id.slice(0, 8)}
                </span>
              ))}
              {ids.length > 12 && <span>+ {String(ids.length - 12)} more</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Helpers ---------------------------------------------------------

function renderHealth(error: string | null): ReactNode {
  if (error !== null) return <span className="health-bad">offline</span>;
  return <span className="health-ok">online</span>;
}

function formatUptime(snapshot: StateSnapshotWire): string {
  const ms = new Date(snapshot.now).getTime() - new Date(snapshot.daemonStartedAt).getTime();
  return formatDuration(ms);
}
