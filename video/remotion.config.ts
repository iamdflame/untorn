// Remotion settings for the studio and the CLI. Renders go through scripts/render.mjs, which also links the
// gitignored captures into the bundle.
import { Config } from "@remotion/cli/config";

Config.setEntryPoint("./src/index.ts");
Config.setPublicDir("./public");
Config.setVideoImageFormat("jpeg");
Config.setJpegQuality(95);
Config.setChromiumOpenGlRenderer("angle");
Config.setConcurrency(6);
