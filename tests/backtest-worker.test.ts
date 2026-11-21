import { beforeEach, describe, expect, it, vi } from "vitest";
import { withBacktestWorker } from "../scripts/backtest-worker.ts";

const { start, stop } = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn()
}));

vi.mock("wrangler", () => ({ unstable_dev: start }));

beforeEach(() => {
  vi.resetAllMocks();
  stop.mockResolvedValue(undefined);
  start.mockResolvedValue({ address: "127.0.0.1", port: 12345, stop });
});

describe("automatic backtest Worker lifecycle", () => {
  it("starts a local persistent Worker on an available port and stops it after the run", async () => {
    const run = vi.fn(async (url: URL) => {
      expect(url.origin).toBe("http://127.0.0.1:12345");
      expect(stop).not.toHaveBeenCalled();
    });
    await withBacktestWorker(null, run);
    expect(start).toHaveBeenCalledWith(expect.stringMatching(/[\\/]src[\\/]index\.ts$/), expect.objectContaining({
      config: expect.stringMatching(/[\\/]wrangler\.toml$/),
      local: true, ip: "127.0.0.1", port: 0, inspectorPort: 0,
      persist: true, persistTo: expect.stringMatching(/[\\/]\.wrangler[\\/]state$/),
      experimental: expect.objectContaining({ forceLocal: true, watch: false })
    }));
    expect(run).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("stops the owned Worker when simulation or API handling fails", async () => {
    await expect(withBacktestWorker(null, async () => {
      throw new Error("API rejected config.");
    })).rejects.toThrow("API rejected config.");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("does not start or stop an explicitly specified Worker", async () => {
    const url = new URL("https://wtrack.example");
    const run = vi.fn(async () => {});
    await withBacktestWorker(url, run);
    expect(run).toHaveBeenCalledWith(url, expect.any(AbortSignal));
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("surfaces startup failures and restores signal listeners", async () => {
    const before = {
      interrupt: process.listeners("SIGINT"),
      terminate: process.listeners("SIGTERM")
    };
    start.mockRejectedValue(new Error("Could not start Worker."));
    const run = vi.fn();
    await expect(withBacktestWorker(null, run)).rejects.toThrow("Could not start Worker.");
    expect(run).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(process.listeners("SIGINT")).toEqual(before.interrupt);
    expect(process.listeners("SIGTERM")).toEqual(before.terminate);
  });

  it("aborts an interrupted request and still stops the Worker and removes listeners", async () => {
    const before = process.listeners("SIGINT");
    await expect(withBacktestWorker(null, async (_url, signal) => {
      const interrupt = process.listeners("SIGINT").find((listener) => !before.includes(listener));
      expect(interrupt).toBeDefined();
      interrupt!("SIGINT");
      signal.throwIfAborted();
    })).rejects.toThrow("Backtest interrupted.");
    expect(stop).toHaveBeenCalledOnce();
    expect(process.listeners("SIGINT")).toEqual(before);
  });
});
