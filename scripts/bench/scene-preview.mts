// Write the synthetic test scene to disk to look at it.
import { writeFileSync } from "node:fs";
import { renderScene } from "../../src/lib/server/__fixtures__/scene";
writeFileSync(process.argv[2] ?? "scene.jpg", await renderScene());
