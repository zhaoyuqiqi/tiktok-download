import { build } from "bun";
build({
  entrypoints: ["src/crawler/github-actions.ts"],
  target: "node",
  outdir: 'dist'
});
