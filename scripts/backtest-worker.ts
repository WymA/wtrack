import { fileURLToPath } from "node:url";
import type { Unstable_DevWorker } from "wrangler";

const root = new URL("../", import.meta.url);

export async function withBacktestWorker(
  url: URL | null,
  run: (url: URL, signal: AbortSignal) => Promise<void>
): Promise<void> {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Backtest interrupted."));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let worker: Unstable_DevWorker | undefined;
  try {
    if (!url) {
      const { unstable_dev } = await import("wrangler");
      controller.signal.throwIfAborted();
      worker = await unstable_dev(fileURLToPath(new URL("src/index.ts", root)), {
        config: fileURLToPath(new URL("wrangler.toml", root)),
        local: true,
        ip: "127.0.0.1",
        port: 0,
        inspectorPort: 0,
        persist: true,
        persistTo: fileURLToPath(new URL(".wrangler/state", root)),
        logLevel: "error",
        experimental: {
          disableExperimentalWarning: true,
          disableDevRegistry: true,
          forceLocal: true,
          watch: false
        }
      });
      url = new URL(`http://${worker.address}:${worker.port}`);
    }
    controller.signal.throwIfAborted();
    await run(url, controller.signal);
  } finally {
    try {
      await worker?.stop();
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
  }
}
