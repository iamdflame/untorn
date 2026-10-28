"use client";

// The hero: the photo of torn pieces, SAM's outline on every piece, the pieces under test while Muse reads a
// seam, and every placed piece carried to its pose on the rebuilt page.
//
// Motion hooks for the design pass: the root has data-phase (empty | photo | outlined | reading | assembled), each
// piece is a <g data-piece> with data-placed / data-testing / data-unplaced and --i (its index); outlines are
// <polygon class="stage-outline" pathLength=1> for a draw-on. CSS lives in globals.css under ".stage".

import { useId, useMemo } from "react";
import { placedPoses, type RunState } from "@/lib/run/state";
import { layoutPages, pieceMatrix, pointsAttr } from "./geometry";

export type StagePhase = "empty" | "photo" | "outlined" | "reading" | "assembled";

export function stagePhase(s: RunState): StagePhase {
  if (s.pages.length) return "assembled";
  if (s.stages.read.status === "active" || s.reads.length) return "reading";
  if (s.pieces.length) return "outlined";
  if (s.photo || s.mode !== "live") return "photo";
  return "empty";
}

export function PhotoStage({
  state,
  reducedMotion,
  fallbackPhoto,
  className = "",
}: {
  state: RunState;
  reducedMotion: boolean;
  /** Shown before the run's own photo arrives (the first paint of the first screen). */
  fallbackPhoto?: { url: string; width: number; height: number };
  className?: string;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const phase = stagePhase(state);
  const photo = state.photo ?? (state.mode === "live" ? null : fallbackPhoto) ?? null;
  const W = photo?.width ?? 1600;
  const H = photo?.height ?? 1200;
  const photoUrl = photo?.url ?? null;
  const slots = useMemo(() => layoutPages(state.pages, W, H), [state.pages, W, H]);
  const placed = useMemo(() => placedPoses(state), [state]);
  const unplaced = new Set(state.unplaced.map((u) => u.id));
  const testing = new Set(phase === "reading" && state.stages.read.status === "active" ? (state.reads.at(-1)?.pieces ?? []) : []);
  // unplaced first, so assembled pages paint over them
  const order = [...state.pieces].sort((a, b) => Number(placed.has(a.id)) - Number(placed.has(b.id)));
  const placedCount = placed.size;
  const stroke = Math.max(2, W / 420);
  const label =
    phase === "assembled"
      ? `${state.pieces.length} torn pieces; ${placedCount} placed on ${state.pages.length} rebuilt page${state.pages.length === 1 ? "" : "s"}${unplaced.size ? `, ${unplaced.size} left unplaced` : ""}.`
      : state.pieces.length
        ? `Photo of ${state.pieces.length} torn pieces, each outlined.`
        : "Photo of torn pieces of paper on a desk.";

  return (
    <div className={`stage ${className}`} data-phase={phase} data-motion={reducedMotion ? "reduced" : "full"}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="stage-svg" preserveAspectRatio="xMidYMid meet">
        <defs>
          {state.pieces.map((p) => (
            <clipPath id={`${uid}-${p.id}`} key={p.id}>
              <polygon points={pointsAttr(p.polygon)} />
            </clipPath>
          ))}
        </defs>
        <rect width={W} height={H} className="stage-desk-fill" />
        {photoUrl && <image href={photoUrl} width={W} height={H} preserveAspectRatio="none" className="stage-desk" />}
        {order.map((p, i) => {
          const pp = placed.get(p.id);
          const slot = pp ? slots[pp.page] : undefined;
          const transform = phase === "assembled" && pp && slot ? pieceMatrix(pp.pose, slot) : undefined;
          return (
            <g
              key={p.id}
              data-piece={p.id}
              data-placed={pp ? "" : undefined}
              data-unplaced={phase === "assembled" && unplaced.has(p.id) ? "" : undefined}
              data-testing={testing.has(p.id) ? "" : undefined}
              data-blank={p.text ? undefined : ""}
              className="stage-piece"
              style={{ transform, ["--i" as string]: i }}
            >
              {photoUrl && <image href={photoUrl} width={W} height={H} preserveAspectRatio="none" clipPath={`url(#${uid}-${p.id})`} className="stage-paper" />}
              <polygon points={pointsAttr(p.polygon)} pathLength={1} className="stage-outline" strokeWidth={stroke} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
