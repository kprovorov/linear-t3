import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  // One ESM bundle for the published CLI. Dependencies stay external (tsdown's default).
  // `fixedExtension: false` emits `dist/cli.js` rather than `.mjs`; the `bin` in package.json
  // points at that name.
  pack: {
    entry: { cli: "src/cli.ts" },
    format: "esm",
    platform: "node",
    outDir: "dist",
    fixedExtension: false,
  },
});
