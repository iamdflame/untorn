// The real-tear thumbnail (1280x720 still): before and after on real paper. The one photo of a page torn by hand
// into 6 pieces, and the same page whole on the app's light table at the end of the live run filmed for the
// "Tear your own" beat (run g3sj5fmhr33xem8j), its seams violet where Muse read across them. Both are real pixels
// from capture/golden-real/thumb (gitignored, made from the run's photo and capture frame 1600; video/README.md).
// Laid out at 1920x1080 and scaled, like Thumbnail.
import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { TornWord } from "../components/TornWord";
import { C, F } from "../theme";

const DIR = "capture/golden-real/thumb";
const FEATHER = "linear-gradient(to right, transparent, #000 10%, #000 97%, transparent), linear-gradient(to bottom, transparent, #000 6%, #000 97%, transparent)";

export const ThumbnailReal: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: C.room }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: 1920, height: 1080, transform: "scale(0.66667)", transformOrigin: "0 0", overflow: "hidden" }}>
        <div style={{ position: "absolute", inset: 0, background: `radial-gradient(48% 70% at 77% 50%, rgba(253,243,223,0.16), rgba(51,44,39,0) 70%)` }} />
        <TornWord text="Untorn" t={20} t0={0} seat={0} x={92} y={84} size={210} />
        <div style={{ position: "absolute", left: 100, top: 400, fontFamily: F.serif, fontWeight: 500, fontSize: 70, lineHeight: 1.08, color: C.chalk }}>
          Torn by hand.
          <br />
          One photo.
          <br />
          Whole again.
        </div>
        {/* after: the page whole, real pixels from the run's light table, feathered into the room */}
        <Img
          src={staticFile(`${DIR}/page-raw.jpg`)}
          style={{
            position: "absolute",
            left: 990,
            top: -20,
            height: 1120,
            WebkitMaskImage: FEATHER,
            WebkitMaskComposite: "source-in",
            maskImage: FEATHER,
            maskComposite: "intersect",
          }}
        />
        {/* before: the photo as taken, laid on the table like a print */}
        <div style={{ position: "absolute", left: 660, top: 300, width: 432, height: 576, transform: "rotate(-5deg)", boxShadow: "0 30px 70px rgba(14,10,8,0.6)", border: `10px solid ${C.chalk}`, borderBottomWidth: 44, background: C.chalk }}>
          <Img src={staticFile(`${DIR}/photo.jpg`)} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
          <div style={{ position: "absolute", left: 0, right: 0, bottom: -38, textAlign: "center", fontFamily: F.sans, fontWeight: 600, fontSize: 22, color: C.room }}>The photo: 6 pieces</div>
        </div>
        <div style={{ position: "absolute", left: 100, bottom: 40, fontFamily: F.serif, fontWeight: 500, fontSize: 24, color: C.chalk3 }}>
          A page torn by hand, rebuilt live on untorn.vercel.app in 55 s.
        </div>
      </div>
    </AbsoluteFill>
  );
};
