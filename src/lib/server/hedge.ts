// Hedged requests: when a call has not answered by `afterMs`, start an identical one beside it and take whichever
// answers first (the other is aborted). The model API has a long latency tail: in the bench a SAM call that normally
// answers in 2–5 s hung for 45 s once and took 29 s another time, and Muse calls of ~10 s have run past 60 s.
// A hedge costs one extra request only when it fires.

export type HedgeOutcome<T> = { result: T; lane: number; lanesStarted: number; results: T[] };

/**
 * Run `run` in lane 0; after each `afterMs` without a good answer start another lane, up to `lanes`.
 * Resolves with the first result that `ok` accepts (aborting the rest), or, when every started lane has finished
 * without one and no lane is still to come, with the last result.
 */
export function hedge<T>(
  run: (signal: AbortSignal, lane: number) => Promise<T>,
  opts: {
    afterMs?: number;
    lanes?: number;
    signal?: AbortSignal;
    ok: (r: T) => boolean;
    /** A bad result that another lane would only repeat (e.g. a 400): settle with it at once. */
    final?: (r: T) => boolean;
    finalError?: (e: unknown) => boolean;
    onHedge?: (lane: number) => void;
  },
): Promise<HedgeOutcome<T>> {
  const lanes = opts.afterMs && opts.afterMs > 0 ? Math.max(1, opts.lanes ?? 2) : 1;
  return new Promise((resolve, reject) => {
    const controllers: AbortController[] = [];
    const results: T[] = [];
    let running = 0;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (r: HedgeOutcome<T> | { error: unknown }) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      controllers.forEach((c, lane) => {
        if (!("lane" in r) || r.lane !== lane) c.abort(new Error("hedge settled"));
      });
      if ("error" in r) reject(r.error);
      else resolve(r);
    };
    const onAbort = () => finish({ error: opts.signal?.reason ?? new Error("aborted") });
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const start = (lane: number) => {
      if (done) return;
      const c = new AbortController();
      controllers.push(c);
      running++;
      if (lane > 0) opts.onHedge?.(lane);
      const signal = opts.signal ? AbortSignal.any([opts.signal, c.signal]) : c.signal;
      run(signal, lane).then(
        (r) => {
          running--;
          results.push(r);
          if (opts.ok(r) || opts.final?.(r)) finish({ result: r, lane, lanesStarted: controllers.length, results });
          else if (!running && controllers.length >= lanes) finish({ result: r, lane, lanesStarted: controllers.length, results });
          else if (!running) {
            // this lane gave up before the next hedge was due: start it now rather than wait
            if (timer) clearTimeout(timer);
            start(controllers.length);
          }
        },
        (e) => {
          running--;
          if (opts.finalError?.(e) || (!running && controllers.length >= lanes)) finish({ error: e });
          else if (!running) {
            if (timer) clearTimeout(timer);
            start(controllers.length);
          }
        },
      );
      if (controllers.length < lanes) timer = setTimeout(() => start(controllers.length), opts.afterMs);
    };
    if (opts.signal?.aborted) return finish({ error: opts.signal.reason });
    start(0);
  });
}
