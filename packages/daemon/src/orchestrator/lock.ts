// `AsyncLock` — a tiny mutex for serializing async state mutations.
//
// SPEC §7 / §16: the orchestrator is the single authority for state
// mutations. JavaScript is single-threaded, but `await` boundaries
// can interleave concurrent async functions. Without serialization,
// two mutators could both observe `state.running.has(id) === false`
// before either actually adds it — classic check-then-set race.
//
// `AsyncLock.run(fn)` enqueues `fn` to run after every previous
// acquisition has completed. Inside `fn`, you can await freely; no
// other `run` callback will execute until yours returns.
//
// We chain via a Promise: `chain` always points to the tail of the
// queue. Each `run` schedules its work after `chain`, then advances
// `chain` past the new work. Errors in one queued task are swallowed
// in the chain so they don't poison subsequent acquisitions; they
// still propagate to the caller via the returned promise.

export class AsyncLock {
  private chain: Promise<void> = Promise.resolve();

  /**
   * Run `fn` exclusively. Returns a promise that resolves to `fn`'s
   * return value (or rejects with `fn`'s thrown error).
   */
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.chain.then(() => fn());
    // Advance the chain regardless of whether `fn` succeeded. Without
    // this, one rejection would leave `chain` rejected forever and
    // every subsequent `run` would inherit the rejection.
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
