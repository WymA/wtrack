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
  const assetsFetch = vi.fn(async () => new Response("Not found", { status: 404 }));
  const env = {
    WTRACK_KV: kv,
    ASSETS: { fetch: assetsFetch }
  } as unknown as Env;

  return { env, assetsFetch };
}

describe("watchlist endpoint", () => {
  it("merges and removes the legacy holdings list", async () => {
    const values = new Map([
      ["watchlist", '["aapl","MSFT"]'],
      ["holdings", '["MSFT","NVDA"]']
    ]);
    const { env } = createEnv(values);
    const request = new Request("https://wtrack.example/watchlist");

    const response = await worker.fetch(request, env);

    expect(await response.json()).toEqual({
      watchlist: ["AAPL", "MSFT", "NVDA"],
      snapshot: null
    });
    expect(values.get("watchlist")).toBe('["AAPL","MSFT","NVDA"]');
    expect(values.has("holdings")).toBe(false);
  });

  it("does not expose a separate holdings endpoint", async () => {
    const { env, assetsFetch } = createEnv(new Map());
    const request = new Request("https://wtrack.example/holdings");

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(404);
    expect(assetsFetch).toHaveBeenCalledOnce();
  });
});
