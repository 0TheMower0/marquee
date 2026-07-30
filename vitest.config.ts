import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirrors tsconfig.json's "@/*": ["./*"] so test files can import from
    // "@/lib/..." exactly like app code.
    alias: {
      "@": path.resolve(__dirname),
    },
  },
});
