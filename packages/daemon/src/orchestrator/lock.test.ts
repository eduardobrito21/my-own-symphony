import { describe, expect, it } from 'vitest';

import { AsyncLock } from './lock.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('AsyncLock', () => {
  it('serializes overlapping critical sections', async () => {
    const lock = new AsyncLock();
    const log: string[] = [];
    const a = lock.run(async () => {
      log.push('a-start');
      await delay(20);
      log.push('a-end');
      return 'A';
    });
    const b = lock.run(async () => {
      log.push('b-start');
      await delay(5);
      log.push('b-end');
      return 'B';
    });
    expect(await Promise.all([a, b])).toEqual(['A', 'B']);
    expect(log).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('returns the function result through the promise', async () => {
    const lock = new AsyncLock();
    expect(await lock.run(() => 42)).toBe(42);
    expect(await lock.run(() => Promise.resolve('hello'))).toBe('hello');
  });

  it('propagates exceptions to the caller', async () => {
    const lock = new AsyncLock();
    await expect(
      lock.run(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow(/boom/);
  });

  it('does not poison subsequent acquisitions when one throws', async () => {
    const lock = new AsyncLock();
    await expect(
      lock.run(() => {
        throw new Error('first');
      }),
    ).rejects.toThrow(/first/);
    expect(await lock.run(() => 'second-ok')).toBe('second-ok');
  });
});
