import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  // One ESM bundle for the published CLI. Dependencies stay external (tsdown's default).
  pack: {
    entry: { cli: "src/cli.ts" },
    format: "esm",
    platform: "node",
    outDir: "dist",
    fixedExtension: false,
  },
});
