// Structured logger interface for the daemon.
//
// SPEC §13.1 requires every issue-related log to carry `issue_id`,
// `issue_identifier`, and (for session lifecycle) `session_id`.
// Spec §13.2 says the implementation chooses where to write logs;
// we default to stderr in `key=value` format here, with an option
// to bind a context (e.g. per-issue) so the orchestrator doesn't
// have to pass these IDs into every call site.
//
// Plan 08 may swap the underlying impl to `pino` for JSON output;
// the interface stays the same.

/**
 * Severity levels we emit. We don't have a `debug` level intentionally
 * — once you reach for "debug", you usually want a tracing tool, not
 * unstructured logs in production output.
 */
export type LogLevel = 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

/**
 * A logger. The `with` method returns a child logger that merges the
 * given fields into every emitted record. Used like:
 *
 *   const issueLogger = log.with({ issue_id, issue_identifier });
 *   issueLogger.info('dispatching');     // includes the IDs
 *   issueLogger.with({ session_id }).info('session_started');
 */
export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  with(fields: LogFields): Logger;
}

const TOKEN_LIKE = /(lin_|sk-|sk_)[A-Za-z0-9_-]{8,}/g;

/**
 * Mask token-shaped values in any string. Applied to the message body
 * and to every string-valued field at render time. SPEC §15.3: do not
 * log API tokens.
 */
function redactTokens(value: string): string {
  return value.replace(TOKEN_LIKE, (match) => `${match.slice(0, 4)}***`);
}

function renderFields(fields: LogFields): string {
  return Object.entries(fields)
    .map(([key, raw]) => {
      const value = formatValue(raw);
      return `${key}=${value}`;
    })
    .join(' ');
}

function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(redactTokens(value));
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return JSON.stringify(redactTokens(value.message));
  try {
    return JSON.stringify(value, (_key, raw: unknown) =>
      typeof raw === 'string' ? redactTokens(raw) : raw,
    );
  } catch {
    return '"[unserializable]"';
  }
}

interface ConsoleLoggerOptions {
  readonly stream?: NodeJS.WritableStream;
  readonly baseFields?: LogFields;
  /** Override the clock for deterministic tests. */
  readonly now?: () => Date;
}

class ConsoleLogger implements Logger {
  private readonly stream: NodeJS.WritableStream;
  private readonly baseFields: LogFields;
  private readonly now: () => Date;

  constructor(options: ConsoleLoggerOptions = {}) {
    this.stream = options.stream ?? process.stderr;
    this.baseFields = options.baseFields ?? {};
    this.now = options.now ?? (() => new Date());
  }

  info(message: string, fields?: LogFields): void {
    this.emit('info', message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.emit('warn', message, fields);
  }
  error(message: string, fields?: LogFields): void {
    this.emit('error', message, fields);
  }

  with(fields: LogFields): Logger {
    return new ConsoleLogger({
      stream: this.stream,
      baseFields: { ...this.baseFields, ...fields },
      now: this.now,
    });
  }

  private emit(level: LogLevel, message: string, fields?: LogFields): void {
    const merged: LogFields = { ...this.baseFields, ...fields };
    const fieldStr = Object.keys(merged).length > 0 ? ' ' + renderFields(merged) : '';
    const line = `${this.now().toISOString()} ${level.toUpperCase()} ${redactTokens(message)}${fieldStr}\n`;
    this.stream.write(line);
  }
}

/** Construct the default console logger. */
export function createConsoleLogger(options: ConsoleLoggerOptions = {}): Logger {
  return new ConsoleLogger(options);
}

/** A logger that drops every record. Useful as a default in tests. */
export const NULL_LOGGER: Logger = {
  info() {
    /* intentionally empty */
  },
  warn() {
    /* intentionally empty */
  },
  error() {
    /* intentionally empty */
  },
  with() {
    return NULL_LOGGER;
  },
};
