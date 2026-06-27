#!/usr/bin/env node
/**
 * build-server.mjs — esbuild wrapper that injects the git SHA at build time.
 *
 * Why a script instead of an inline npm script?
 * Shell-expanding $(git rev-parse) inside a JSON string in package.json
 * is a quoting nightmare. This script does it cleanly and is the standard
 * pattern for esbuild with build-time defines.
 *
 * Used by: npm run build (package.json)
 * Consumed by: src/controllers/health.controller.ts (__BUILD_SHA__)
 * Verified by: ship.sh step [4/4] polling /healthz for the SHA
 */
import { execSync } from "child_process";
import { build } from "esbuild";

let sha = "unknown";
try {
  sha = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
} catch {
  console.warn("⚠️  git not available — BUILD_SHA will be 'unknown'");
}

console.log(`[build-server] Injecting BUILD_SHA=${sha}`);

await build({
  entryPoints: ["server.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  packages: "external",
  sourcemap: true,
  outfile: "dist/server.cjs",
  define: {
    __BUILD_SHA__: JSON.stringify(sha),
  },
});

console.log(`[build-server] dist/server.cjs built successfully (sha: ${sha})`);
