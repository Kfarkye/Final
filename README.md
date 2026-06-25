<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/73e9ce7f-7347-4837-a758-ccae784691f2

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Workspace Integrity

This repo ships a **workspace manifest** (`workspace.manifest.json`) that declares the canonical shape of the monorepo — every required file and directory, grouped by component.

Any runtime (CI, Cloud Run shell, agent exec, bare terminal) can verify the tree is complete:

```bash
node scripts/verify-workspace.mjs              # verify all components
node scripts/verify-workspace.mjs --only app   # verify one component
node scripts/verify-workspace.mjs --json       # machine-readable output
```

**A non-zero exit means the mount is partial** — `src/`, `server.ts`, or another required path is missing. Re-sync from the full repo root before building, deploying, or reviewing.

The verifier is wired into `prebuild`, so `npm run build` automatically fails closed on an incomplete tree. It has zero dependencies (Node builtins only) and runs on Node ≥16.

