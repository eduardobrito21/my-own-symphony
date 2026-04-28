import { describe, expect, it } from 'vitest';

import { createConsoleLogger } from './logger.js';

class CapturingStream {
  private buf = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  write(chunk: any): boolean {
    this.buf += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  }
  text(): string {
    return this.buf;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  end(): any {
    /* not needed for test */
  }
}

function asWritable(s: CapturingStream): NodeJS.WritableStream {
  return s as unknown as NodeJS.WritableStream;
}

const FIXED = (): Date => new Date('2026-04-28T10:00:00.000Z');

describe('ConsoleLogger', () => {
  it('renders "ts LEVEL message key=value" lines on the configured stream', () => {
    const sink = new CapturingStream();
    const log = createConsoleLogger({ stream: asWritable(sink), now: FIXED });
    log.info('dispatched', { issue_id: 'abc', count: 3 });
    expect(sink.text()).toBe('2026-04-28T10:00:00.000Z INFO dispatched issue_id="abc" count=3\n');
  });

  it('with(fields) merges into every subsequent record', () => {
    const sink = new CapturingStream();
    const log = createConsoleLogger({ stream: asWritable(sink), now: FIXED }).with({
      issue_id: 'abc',
      issue_identifier: 'SYMP-1',
    });
    log.info('start');
    log.warn('uh oh', { reason: 'x' });
    const lines = sink.text().trim().split('\n');
    expect(lines[0]).toContain('issue_id="abc"');
    expect(lines[0]).toContain('issue_identifier="SYMP-1"');
    expect(lines[1]).toContain('reason="x"');
    expect(lines[1]).toContain('issue_id="abc"');
  });

  it('redacts token-shaped strings in messages and fields', () => {
    const sink = new CapturingStream();
    const log = createConsoleLogger({ stream: asWritable(sink), now: FIXED });
    log.info('using key lin_abcdef1234567890', { api_key: 'lin_secret_abc1234567890' });
    const out = sink.text();
    expect(out).not.toContain('abcdef1234567890');
    expect(out).not.toContain('secret_abc1234567890');
    expect(out).toContain('lin_***');
  });

  it('formats Date values as ISO-8601', () => {
    const sink = new CapturingStream();
    const log = createConsoleLogger({ stream: asWritable(sink), now: FIXED });
    log.info('event', { at: new Date('2026-04-28T11:22:33.000Z') });
    expect(sink.text()).toContain('at=2026-04-28T11:22:33.000Z');
  });

  it('emits ERROR level on .error()', () => {
    const sink = new CapturingStream();
    const log = createConsoleLogger({ stream: asWritable(sink), now: FIXED });
    log.error('boom');
    expect(sink.text()).toContain(' ERROR boom');
  });
});
