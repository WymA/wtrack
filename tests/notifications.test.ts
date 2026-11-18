import { describe, expect, it, vi } from "vitest";
import { sendNewAlerts } from "../src/notifications";
import type { Env, StockAlert } from "../src/types";

const alert: StockAlert = {
  ticker: "AAPL",
  type: "Exit Tier 2",
  date: "2026-11-16",
  close: 90,
  stopLoss: 89,
  ema20: 100,
  ema50: 100,
  ema100: 100,
  ema200: 100
};

describe("optional webhook notifications", () => {
  it.each([undefined, null, "", "   "])("does not send or record alerts when the URL is %s", async (url) => {
    const get = vi.fn();
    const put = vi.fn();
    const env = { WEBHOOK_URL: url, WTRACK_KV: { get, put } } as unknown as Env;
    const fetcher = vi.fn();
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubGlobal("fetch", fetcher);
    try {
      expect(await sendNewAlerts([alert], alert.date, env)).toEqual([]);
      expect(get).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      log.mockRestore();
    }
  });

  it("still reports configured webhook failures without recording the alert", async () => {
    const put = vi.fn();
    const env = {
      WEBHOOK_URL: "https://example.test/webhook",
      WTRACK_KV: { get: vi.fn().mockResolvedValue(null), put }
    } as unknown as Env;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    try {
      await expect(sendNewAlerts([alert], alert.date, env))
        .rejects.toThrow("Webhook request failed with status 500.");
      expect(put).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sends and records alerts when a webhook is configured", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const env = {
      WEBHOOK_URL: "https://example.test/webhook",
      WTRACK_KV: { get: vi.fn().mockResolvedValue(null), put }
    } as unknown as Env;
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    try {
      expect(await sendNewAlerts([alert], alert.date, env)).toEqual([alert]);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(put).toHaveBeenCalledWith(
        "alerts:2026-11-16",
        '["AAPL:Exit Tier 2"]',
        expect.objectContaining({ expirationTtl: expect.any(Number) })
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
