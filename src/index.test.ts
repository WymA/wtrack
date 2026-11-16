import { describe, expect, it, vi } from "vitest";
import worker from "./index";
import type { Env } from "./types";

function createEnv(values: Map<string, string>) {
  const kv = {
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
    async delete(key: string) {
      values.delete(key);
    }
  };
  const assetsFetch = vi.fn(async (request: Request) => {
    if (new URL(request.url).pathname === "/admin") return new Response("Admin page");
    return new Response("Not found", { status: 404 });
  });
  const env = {
    WTRACK_KV: kv,
    ASSETS: { fetch: assetsFetch }
  } as unknown as Env;

  return { env, assetsFetch };
}

describe("admin actions", () => {
  it("merges and removes the legacy holdings list", async () => {
    const values = new Map([
      ["watchlist", '["aapl","MSFT"]'],
      ["holdings", '["MSFT","NVDA"]']
    ]);
    const { env } = createEnv(values);
    const request = new Request("https://wtrack.example/admin/watchlist");

    const response = await worker.fetch(request, env);

    expect(await response.json()).toEqual({
      watchlist: ["AAPL", "MSFT", "NVDA"],
      snapshot: null,
      lastScheduledRun: null
    });
    expect(values.get("watchlist")).toBe('["AAPL","MSFT","NVDA"]');
    expect(values.has("holdings")).toBe(false);
  });

  it("does not expose the old standalone action routes", async () => {
    const { env, assetsFetch } = createEnv(new Map());
    for (const path of ["/scan", "/ping", "/watchlist"]) {
      const request = new Request(`https://wtrack.example${path}`);
      const response = await worker.fetch(request, env);
      expect(response.status).toBe(404);
    }
    expect(assetsFetch).toHaveBeenCalledTimes(3);
  });

  it("serves the admin page at /admin", async () => {
    const { env } = createEnv(new Map());
    const request = new Request("https://wtrack.example/admin");

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Admin page");
  });

  it("records scheduled failures and exposes the latest run record", async () => {
    const values = new Map<string, string>();
    const { env } = createEnv(values);
    const scheduledWork: Promise<unknown>[] = [];
    const context = {
      waitUntil(promise: Promise<unknown>) {
        scheduledWork.push(promise);
      }
    } as unknown as ExecutionContext;
    const controller = {
      scheduledTime: Date.parse("2026-11-16T21:30:00Z"),
      cron: "30 21 * * 1-5"
    } as ScheduledController;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      worker.scheduled(controller, env, context);
      const task = scheduledWork[0];
      if (!task) throw new Error("The scheduled task was not registered.");
      await expect(task).rejects.toThrow("ALPACA_API_KEY and ALPACA_API_SECRET_KEY must be configured.");

      const storedRecord = values.get("last-scheduled-run");
      expect(storedRecord).toBeDefined();
      expect(JSON.parse(storedRecord ?? "")).toEqual({
        completedAt: expect.any(String),
        success: false
      });

      const response = await worker.fetch(new Request("https://wtrack.example/admin/watchlist"), env);
      const payload = await response.json() as { lastScheduledRun: unknown };
      expect(payload.lastScheduledRun).toEqual(JSON.parse(storedRecord ?? ""));
    } finally {
      errorSpy.mockRestore();
    }
  });
});
