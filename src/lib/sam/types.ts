// Shapes shared by the SAM 3.1 request builders, the response parser and the mask decoder.

/** An axis-aligned box in image pixels (origin top-left). */
export type Box = [x1: number, y1: number, x2: number, y2: number];

/** SAM's mask for one object, kept in SAM's own encoding: decoded where it's needed. */
export type EncodedMask = { x: number; y: number; w: number; h: number; data: string };
