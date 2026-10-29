import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    // Agent worktrees and run state live inside the repo folder but are not part of it.
    exclude: [...configDefaults.exclude, ".claude/**", ".apex/**", "e2e/**", "video/**"],
  },
});
