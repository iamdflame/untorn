import { describe, expect, it } from "vitest";
import { analyzeFragment } from "./fragment";
import { poseCompose, poseInvert, type Pose } from "./geom";
import { textAgreement } from "./textlines";
import { gridTear, scatterPiece } from "./__tests__/synth";

describe("textAgreement", () => {
  // two neighbouring pieces of a page with text lines every 22 px, scattered at different rotations
  const page = gridTear(420, 360, 2, 1, 4);
  const pa: Pose = { theta: 0.35, tx: 600, ty: 400 };
  const pb: Pose = { theta: -1.1, tx: 1500, ty: 900 };
  const A = analyzeFragment(scatterPiece(page, 0, pa, { noise: 0.4 }), 0)!;
  const B = analyzeFragment(scatterPiece(page, 1, pb, { noise: 0.4 }), 1)!;
  // b's photo → a's photo: b's photo → page → a's photo
  const truth = poseCompose(pa, poseInvert(pb));
  const at: [number, number] = [A.centroid[0], A.centroid[1]];

  it("agrees on the true join: same direction, same line phase, same pitch", () => {
    const t = textAgreement(A, B, truth, at)!;
    expect(t).not.toBeNull();
    expect((t.angle * 180) / Math.PI).toBeLessThan(1.5);
    expect(Math.abs(t.phase)).toBeLessThan(0.1);
    expect(Math.abs(t.pitchRatio - 1)).toBeLessThan(0.02);
    expect(t.weight).toBeGreaterThan(0.5);
  });

  it("sees a join shifted by half a line, and one turned off the lines", () => {
    // shift b by half a pitch across the lines (page y), in a's photo frame
    const half: Pose = poseCompose(pa, poseCompose({ theta: 0, tx: 0, ty: 11 }, poseInvert(pb)));
    expect(Math.abs(textAgreement(A, B, half, at)!.phase)).toBeGreaterThan(0.35);
    const turned: Pose = poseCompose({ theta: 0.12, tx: 0, ty: 0 }, truth);
    expect((textAgreement(A, B, turned, at)!.angle * 180) / Math.PI).toBeGreaterThan(5);
  });
});
