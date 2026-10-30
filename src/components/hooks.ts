"use client";

import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";

const motionQuery = "(prefers-reduced-motion: reduce)";

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(motionQuery);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(motionQuery).matches,
    () => false,
  );
}

/** True once `ref` comes within `margin` of the viewport, or the page has been idle for `idleMs` (below-the-fold work waits). */
export function useNearOrIdle(ref: RefObject<Element | null>, margin = "1200px", idleMs = 3500): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (on) return;
    const el = ref.current;
    const io = el
      ? new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setOn(true), { rootMargin: margin })
      : null;
    if (el) io!.observe(el);
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const timer = setTimeout(() => (ric ? ric(() => setOn(true), { timeout: 2000 }) : setOn(true)), idleMs);
    return () => {
      io?.disconnect();
      clearTimeout(timer);
    };
  }, [ref, margin, idleMs, on]);
  return on;
}
