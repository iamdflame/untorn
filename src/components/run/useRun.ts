"use client";

// One hook drives every run view: `live()` streams POST /api/runs, `replay()` plays a stored result back on a clock.
// Both fold events through the same reducer, so the screens can't tell them apart except by `state.mode`.

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { PhotoError, preparePhoto, readTilt, responseError } from "@/lib/client/photo";
import { ERRORS } from "@/lib/run/errors";
import { eventsFromResult, playEvents } from "@/lib/run/replay";
import { initialRunState, reduceRun } from "@/lib/run/state";
import type { RunEvent, RunResult } from "@/lib/run/types";

export type LiveInput = { file: File } | { photoId: string } | { sample: string };

/** No progress for this long while running: show the calm "taking longer" state. */
const SLOW_AFTER_MS = 18_000;

export function useRun() {
  const [state, dispatch] = useReducer(reduceRun, undefined, () => initialRunState());
  const stopRef = useRef<(() => void) | null>(null);
  const lastProgress = useRef(0);
  const [slow, setSlow] = useState(false);
  const [replaying, setReplaying] = useState(false);

  const onEvent = useCallback((e: RunEvent) => {
    if (e.type !== "tick") {
      lastProgress.current = Date.now();
      setSlow(false);
    }
    dispatch(e);
  }, []);

  const stop = useCallback(() => {
    stopRef.current?.();
    stopRef.current = null;
    setReplaying(false);
  }, []);

  const replay = useCallback(
    (result: RunResult, opts: { targetMs?: number; instant?: boolean } = {}) => {
      stop();
      dispatch({ type: "reset", mode: "replay" });
      setReplaying(!opts.instant);
      stopRef.current = playEvents(eventsFromResult(result), onEvent, { ...opts, onEnd: () => setReplaying(false) });
    },
    [onEvent, stop],
  );

  const live = useCallback(
    async (input: LiveInput) => {
      stop();
      dispatch({ type: "reset", mode: "live" });
      const ctrl = new AbortController();
      stopRef.current = () => ctrl.abort();
      lastProgress.current = Date.now();
      let finished = false;
      try {
        let res: Response;
        if ("file" in input) {
          const [blob, tilt] = await Promise.all([preparePhoto(input.file), readTilt(input.file)]);
          const form = new FormData();
          form.set("photo", blob, "photo");
          if (tilt) form.set("tilt", JSON.stringify(tilt));
          res = await fetch("/api/runs", { method: "POST", body: form, signal: ctrl.signal });
        } else {
          res = await fetch("/api/runs", { method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json" }, signal: ctrl.signal });
        }
        if (!res.ok || !res.body) throw await responseError(res);
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            const e = JSON.parse(line) as RunEvent;
            if (e.type === "done" || e.type === "error") finished = true;
            onEvent(e);
          }
        }
        if (!finished) dispatch({ type: "client-error", code: "network", message: ERRORS.network.message });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        if (err instanceof PhotoError) dispatch({ type: "client-error", code: err.code, message: err.message });
        else dispatch({ type: "client-error", code: "network", message: ERRORS.network.message });
      }
    },
    [onEvent, stop],
  );

  const reset = useCallback(() => {
    stop();
    dispatch({ type: "reset", mode: null });
  }, [stop]);

  // the calm "taking longer" state
  useEffect(() => {
    if (state.mode !== "live" || (state.status !== "running" && state.status !== "queued")) return;
    const id = setInterval(() => setSlow(Date.now() - lastProgress.current > SLOW_AFTER_MS), 1000);
    return () => clearInterval(id);
  }, [state.mode, state.status]);

  useEffect(() => () => stopRef.current?.(), []);

  return { state, slow: slow && state.mode === "live" && state.status === "running", replaying, live, replay, stop, reset };
}

export type RunHandle = ReturnType<typeof useRun>;
