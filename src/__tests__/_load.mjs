// Loads src/utils.ts under plain node by stripping types with esbuild (ships with spicetify-creator).
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const here = path.dirname(fileURLToPath(import.meta.url));
const out = esbuild.buildSync({
  entryPoints: [path.join(here, "../utils.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  target: "es2022",
});
const code = out.outputFiles[0].text;
export const utils = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);
