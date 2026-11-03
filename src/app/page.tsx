import { FirstScreen } from "@/components/FirstScreen";
import { DEFAULT_SAMPLE, SAMPLES } from "@/lib/run/samples";

// The first paint is the HTML alone: the headline and a blur-up of the photo (inline). The stage-sized photo and the
// recording are fetched once the page is interactive, so they don't compete with the first paint.
export default function Home() {
  // the open-weights reader is offered only where its host is configured (src/lib/server/live.ts)
  return <FirstScreen sample={SAMPLES[DEFAULT_SAMPLE]} openWeights={Boolean(process.env.BASETEN_API_KEY) && process.env.OPEN_WEIGHTS !== "off"} />;
}
