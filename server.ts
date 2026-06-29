import { hydrateModelSecrets } from "./src/config/model-secrets";

async function bootstrap(): Promise<void> {
  await hydrateModelSecrets();
  await import("./server-runtime");
}

bootstrap().catch((err) => {
  console.error("Fatal startup error", err);
  process.exit(1);
});
