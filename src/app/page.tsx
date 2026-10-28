import { preload } from "react-dom";
import { FirstScreen } from "@/components/FirstScreen";
import { DEFAULT_SAMPLE, PHOTO_SIZES, SAMPLES } from "@/lib/run/samples";

export default function Home() {
  const sample = SAMPLES[DEFAULT_SAMPLE];
  // start loading the photo (the first paint of the stage) and the recording with the HTML, not after hydration
  const srcs = sample.photo.sources ?? [];
  preload(srcs[1]?.url ?? sample.photo.url, { as: "image", fetchPriority: "high", imageSrcSet: srcs.map((s) => `${s.url} ${s.w}w`).join(", ") || undefined, imageSizes: srcs.length ? PHOTO_SIZES : undefined });
  preload(sample.recorded, { as: "fetch", crossOrigin: "anonymous" });
  return <FirstScreen sample={sample} />;
}
