import { FirstScreen } from "@/components/FirstScreen";
import { DEFAULT_SAMPLE, SAMPLES } from "@/lib/run/samples";

export default function Home() {
  return <FirstScreen sample={SAMPLES[DEFAULT_SAMPLE]} />;
}
