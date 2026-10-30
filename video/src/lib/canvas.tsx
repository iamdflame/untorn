// A full-frame canvas that redraws every frame from a pure function of time, plus the film grain pass.
import React, { useLayoutEffect, useMemo, useRef } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { FPS, H, W } from "../theme";
import { hash } from "./motion";

export type DrawFn = (g: CanvasRenderingContext2D, t: number, frame: number, scratch: Scratch) => void;
export type Scratch = { a: HTMLCanvasElement; b: HTMLCanvasElement };

export const FrameCanvas: React.FC<{ draw: DrawFn; ready: boolean; style?: React.CSSProperties; offset?: number }> = ({ draw, ready, style, offset = 0 }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const frame = useCurrentFrame() + offset;
  const scratch = useMemo<Scratch | null>(() => {
    if (typeof document === "undefined") return null;
    const mk = () => {
      const c = document.createElement("canvas");
      c.width = W;
      c.height = H;
      return c;
    };
    return { a: mk(), b: mk() };
  }, []);
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c || !ready || !scratch) return;
    const g = c.getContext("2d")!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    draw(g, frame / FPS, frame, scratch);
  }, [frame, ready, draw, scratch]);
  return <canvas ref={ref} width={W} height={H} style={{ position: "absolute", left: 0, top: 0, width: W, height: H, ...style }} />;
};

/** Film grain: a noise tile at a new random offset every frame, laid over with soft light. */
export function grain(g: CanvasRenderingContext2D, tile: HTMLImageElement | undefined, frame: number, amount = 0.07) {
  if (!tile) return;
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = amount;
  g.globalCompositeOperation = "soft-light";
  const ox = -Math.floor(hash(frame * 1.7) * tile.width);
  const oy = -Math.floor(hash(frame * 3.1 + 9) * tile.height);
  for (let x = ox; x < W; x += tile.width) for (let y = oy; y < H; y += tile.height) g.drawImage(tile, x, y);
  g.restore();
}

/** Depth of field in screen space: sharp inside an ellipse around (cx, cy), blurred outside, by `px` of blur. */
export function depthOfField(g: CanvasRenderingContext2D, scratch: Scratch, src: HTMLCanvasElement, cx: number, cy: number, rx: number, ry: number, px: number) {
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  if (px < 0.25) {
    g.drawImage(src, 0, 0);
    g.restore();
    return;
  }
  g.filter = `blur(${px.toFixed(2)}px)`;
  g.drawImage(src, 0, 0);
  g.filter = "none";
  const m = scratch.b.getContext("2d")!;
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.globalCompositeOperation = "source-over";
  m.clearRect(0, 0, W, H);
  m.drawImage(src, 0, 0);
  m.globalCompositeOperation = "destination-in";
  m.translate(cx, cy);
  m.scale(1, ry / rx);
  const gr = m.createRadialGradient(0, 0, rx * 0.45, 0, 0, rx);
  gr.addColorStop(0, "rgba(0,0,0,1)");
  gr.addColorStop(1, "rgba(0,0,0,0)");
  m.fillStyle = gr;
  m.fillRect(-rx * 2, -rx * 2, rx * 4, rx * 4);
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.globalCompositeOperation = "source-over";
  g.drawImage(scratch.b, 0, 0);
  g.restore();
}
