// Motion primitives. The paper physics are the app's own (src/components/hero/draw.ts): a heavy spring with about 2 %
// overshoot for flights, a decaying rotation settle after touchdown, smoothstep and cubic eases.

export const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
export const inv = (a: number, b: number, x: number) => clamp((x - a) / (b - a));
export const smooth = (a: number, b: number, x: number) => {
  const u = clamp((x - a) / (b - a));
  return u * u * (3 - 2 * u);
};
/** Smootherstep (C2): for camera moves, so they start and land without a jolt. */
export const smoother = (a: number, b: number, x: number) => {
  const u = clamp((x - a) / (b - a));
  return u * u * u * (u * (u * 6 - 15) + 10);
};
export const easeIO = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
export const easeOut = (u: number) => 1 - Math.pow(1 - clamp(u), 3);
export const easeIn = (u: number) => Math.pow(clamp(u), 3);
export const expoOut = (u: number) => (u >= 1 ? 1 : 1 - Math.pow(2, -10 * clamp(u)));

const ZETA = 0.78;
const OMEGA = 9.6;
const OD = OMEGA * Math.sqrt(1 - ZETA * ZETA);
/** Heavy spring, low bounce: progress after s seconds (the app's flight curve). */
export const spring = (s: number) => (s <= 0 ? 0 : 1 - Math.exp(-ZETA * OMEGA * s) * (Math.cos(OD * s) + ((ZETA * OMEGA) / OD) * Math.sin(OD * s)));
/** A small rotation overshoot that dies out after the paper touches down. */
export const settle = (s: number) => (s <= 0 ? 0 : Math.exp(-6.5 * s) * Math.sin(15 * s));
/** A softer spring for type and UI (critically damped, no bounce). */
export const soft = (s: number, w = 7) => (s <= 0 ? 0 : 1 - Math.exp(-w * s) * (1 + w * s));

export type Vec = [number, number];
export type Pose = { theta: number; tx: number; ty: number };
export const applyPose = (p: Pose, x: number, y: number): Vec => {
  const c = Math.cos(p.theta);
  const s = Math.sin(p.theta);
  return [c * x - s * y + p.tx, s * x + c * y + p.ty];
};
export const composePose = (a: Pose, b: Pose): Pose => {
  // a ∘ b: first b, then a
  const [tx, ty] = applyPose(a, b.tx, b.ty);
  return { theta: a.theta + b.theta, tx, ty };
};
export const invertPose = (p: Pose): Pose => {
  const c = Math.cos(-p.theta);
  const s = Math.sin(-p.theta);
  return { theta: -p.theta, tx: -(c * p.tx - s * p.ty), ty: -(s * p.tx + c * p.ty) };
};
/** Shortest signed angle from a to b. */
export const angDiff = (a: number, b: number) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

/** A deterministic hash noise in [0, 1) for grain, jitter and drift (no Math.random in renders). */
export const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
};
/** Smooth 1-D value noise in [-1, 1]. */
export const noise1 = (x: number, seed = 0) => {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return lerp(hash(i + seed * 101.3), hash(i + 1 + seed * 101.3), u) * 2 - 1;
};
