import { FirstScreen } from "@/components/FirstScreen";
import { DEFAULT_SAMPLE, SAMPLES } from "@/lib/run/samples";

// The first paint is the HTML alone: the headline and a blur-up of the photo (inline). The stage-sized photo and the
// recording are fetched once the page is interactive, so they don't compete with the first paint.
export default function Home() {
  return <FirstScreen sample={SAMPLES[DEFAULT_SAMPLE]} />;
}
