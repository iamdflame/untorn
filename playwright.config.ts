// e2e of the golden path. Locally: `pnpm build && pnpm e2e` (starts `next start` on :3210). Against a deployment:
// `E2E_BASE_URL=https://… pnpm e2e`. The one live run (real models, about $0.15) needs E2E_LIVE=1.
import { defineConfig } from "@playwright/test";

const base = process.env.E2E_BASE_URL ?? "http://localhost:3210";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: base, channel: "msedge", trace: "retain-on-failure" },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : { command: "pnpm start -p 3210", url: `${base}/api/health?warm=1`, reuseExistingServer: true, timeout: 60_000 },
});
