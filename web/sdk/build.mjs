// Bundles the publisher SDK into web/public so it can be loaded with a plain
// <script> tag. Hosting it ourselves means integrators need no npm install, no
// bundler, and no framework — which was the whole objection to shipping a
// package.
//
// Runs as part of `npm run build`; also runnable directly with `npm run build:sdk`.
import { build } from "esbuild";
import { mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "..", "public", "v1");
mkdirSync(outDir, { recursive: true });

const result = await build({
  entryPoints: [path.join(__dirname, "index.js")],
  outfile: path.join(outDir, "grav-stream.js"),
  bundle: true,
  minify: true,
  sourcemap: true,
  format: "iife",
  globalName: "GravStream",
  platform: "browser",
  target: ["es2020"],
  // mediasoup-client reaches for `process.env.DEBUG` via the debug package.
  define: { "process.env.DEBUG": "undefined", global: "globalThis" },
  banner: {
    js: "/* Grav Stream publisher SDK — https://live.grav.in/docs */",
  },
  metafile: true,
  logLevel: "info",
});

const [outPath] = Object.keys(result.metafile.outputs).filter((f) => f.endsWith(".js"));
const bytes = result.metafile.outputs[outPath].bytes;
console.log(`[sdk] ${outPath} — ${(bytes / 1024).toFixed(1)} KB minified`);
