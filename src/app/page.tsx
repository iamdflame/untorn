import { preload } from "react-dom";
import { FirstScreen } from "@/components/FirstScreen";
import { DEFAULT_SAMPLE, SAMPLES } from "@/lib/run/samples";

export default function Home() {
  const sample = SAMPLES[DEFAULT_SAMPLE];
  // start loading the photo and the recording with the HTML, not after hydration
  preload(sample.photo.url, { as: "image", fetchPriority: "high" });
  preload(sample.recorded, { as: "fetch", crossOrigin: "anonymous" });
  return <FirstScreen sample={sample} />;
}
