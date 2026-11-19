import { afterEach, describe, expect, it, vi } from "vitest";
import { PaperTrading } from "../src/paper-trading";
import type { Env, StockAlert } from "../src/types";

type MockOrder = {
  id: string;
  client_order_id: string;
  symbol: string;
  side: string;
  status: string;
  filled_qty: string;
  qty: string;
  limit_price: string;
};

function alert(ticker: string, type: StockAlert["type"], close = 100): StockAlert {
  return { ticker, type, close, date: "2026-11-16", stopLoss: 90, ema20: 100, ema50: 95, ema100: 90, ema200: 80 };
}

function harness() {
  const stored = new Map<string, unknown>();
  stored.set("enabled", true);
  const brokerOrders: MockOrder[] = [];
  const positions = new Map<string, string>();
  const storage = {
    async get(key: string) { return structuredClone(stored.get(key)); },
    async put(key: string, value: unknown) { stored.set(key, structuredClone(value)); }
  };
  const object = new PaperTrading(
    { storage } as unknown as DurableObjectState,
    { ALPACA_API_KEY: "test-key", ALPACA_API_SECRET_KEY: "test-secret" } as Env
  );
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input.toString());
    expect(url.origin).toBe("https://paper-api.alpaca.markets");
    if (url.pathname === "/v2/account") return Response.json({ id: "paper-account", trading_blocked: false, account_blocked: false });
    if (url.pathname === "/v2/positions") {
      return Response.json([...positions].map(([symbol, qty]) => ({ symbol, qty, side: "long" })));
    }
    if (url.pathname === "/v2/orders" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, string>;
      const order: MockOrder = {
        id: `order-${brokerOrders.length}`, client_order_id: body.client_order_id!,
        symbol: body.symbol!, side: body.side!, status: "new", filled_qty: "0",
        qty: body.qty!, limit_price: body.limit_price!
      };
      brokerOrders.push(order);
      return Response.json(order);
    }
    if (url.pathname === "/v2/orders" && url.searchParams.get("status") === "open") {
      return Response.json(brokerOrders.filter((order) => order.status === "new" || order.status === "partially_filled"));
    }
    if (url.pathname === "/v2/orders:by_client_order_id") {
      const order = brokerOrders.find((item) => item.client_order_id === url.searchParams.get("client_order_id"));
      return order ? Response.json(order) : new Response("Not found", { status: 404 });
    }
    if (url.pathname.startsWith("/v2/orders/") && init?.method === "DELETE") {
      const order = brokerOrders.find((item) => item.id === url.pathname.split("/").at(-1));
      if (!order) return new Response("Not found", { status: 404 });
      order.status = "canceled";
      return new Response(null, { status: 204 });
    }
    if (url.pathname.startsWith("/v2/assets/")) return Response.json({ tradable: true, fractionable: true });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const execute = (alerts: StockAlert[], phase = "close") => object.fetch(new Request("https://paper.internal/execute", {
    method: "POST",
    body: JSON.stringify({ date: "2026-11-16", phase, alerts })
  }));
  return { execute, brokerOrders, positions, stored, object, fetcher };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("paper trading", () => {
  it("returns saved order records newest first without contacting Alpaca, even when off", async () => {
    const { execute, brokerOrders, object, fetcher } = harness();
    expect(await (await object.fetch(new Request("https://paper.internal/orders"))).json()).toEqual({ orders: [] });
    await execute([alert("AAPL", "Setup A"), alert("MSFT", "Setup B")]);
    brokerOrders[0]!.status = "filled";
    await object.fetch(new Request("https://paper.internal/switch", {
      method: "POST", body: JSON.stringify({ enabled: false })
    }));
    fetcher.mockClear();
    const response = await object.fetch(new Request("https://paper.internal/orders"));
    const result = await response.json() as { orders: { ticker: string; status: string; clientId: string }[] };
    expect(result.orders.map((order) => order.ticker)).toEqual(["MSFT", "AAPL"]);
    expect(result.orders[1]).toMatchObject({ status: "new", clientId: expect.stringContaining("AAPL") });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("persists the switch and places no orders while off", async () => {
    const { execute, brokerOrders, object, stored } = harness();
    stored.delete("enabled");
    const setEnabled = (enabled: boolean) => object.fetch(new Request("https://paper.internal/switch", {
      method: "POST", body: JSON.stringify({ enabled })
    }));
    expect(await (await object.fetch(new Request("https://paper.internal/status"))).json()).toEqual({ enabled: false });
    expect(await (await execute([alert("AAPL", "Setup A")])).json()).toEqual({ submitted: 0, disabled: true });
    expect(brokerOrders).toHaveLength(0);
    await setEnabled(true);
    await execute([alert("AAPL", "Setup A")]);
    expect(brokerOrders).toHaveLength(1);
    await setEnabled(false);
    expect(brokerOrders[0]!.status).toBe("new");
  });

  it("uses only the paper endpoint, limits entries to $1000 and five positions, and deduplicates scans", async () => {
    const { execute, brokerOrders } = harness();
    const alerts = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"].map((ticker) => alert(ticker, "Setup A"));
    expect(await (await execute(alerts)).json()).toEqual({ submitted: 5 });
    expect(brokerOrders).toHaveLength(5);
    expect(brokerOrders[0]).toMatchObject({ symbol: "AAA", side: "buy", limit_price: "103.00" });
    expect(Number(brokerOrders[0]!.qty) * 103).toBeLessThanOrEqual(1000);
    expect(await (await execute(alerts)).json()).toEqual({ submitted: 0 });
    expect(brokerOrders).toHaveLength(5);
  });

  it("sells only strategy-owned shares, once for simultaneous exit tiers", async () => {
    const { execute, brokerOrders, positions } = harness();
    await execute([alert("AAPL", "Setup A")]);
    brokerOrders[0]!.status = "filled";
    brokerOrders[0]!.filled_qty = brokerOrders[0]!.qty;
    positions.set("AAPL", brokerOrders[0]!.qty);
    positions.set("MSFT", "10");
    await execute([alert("AAPL", "Exit Tier 2"), alert("AAPL", "Exit Tier 3"), alert("MSFT", "Exit Tier 2")]);
    expect(brokerOrders).toHaveLength(2);
    expect(brokerOrders[1]).toMatchObject({
      symbol: "AAPL", side: "sell", qty: brokerOrders[0]!.qty, limit_price: "97.00"
    });
    await execute([alert("AAPL", "Exit Tier 2")]);
    expect(brokerOrders).toHaveLength(2);
  });

  it("never trades D entries or uses D exits to liquidate A/B-owned shares", async () => {
    const { execute, brokerOrders, positions } = harness();
    await execute([alert("AAPL", "Setup A")]);
    brokerOrders[0]!.status = "filled";
    brokerOrders[0]!.filled_qty = brokerOrders[0]!.qty;
    positions.set("AAPL", brokerOrders[0]!.qty);
    const signals = [
      alert("MSFT", "Setup D"), alert("AAPL", "Exit Tier 2"), alert("AAPL", "Hard Stop"),
      alert("AAPL", "Momentum Rotation")
    ].map((item) => ({ ...item, strategy: "Setup D" as const }));
    expect(await (await execute(signals)).json()).toEqual({ submitted: 0 });
    expect(brokerOrders).toHaveLength(1);
  });

  it("stops if the broker position no longer matches the strategy ledger", async () => {
    const { execute, brokerOrders, positions } = harness();
    await execute([alert("AAPL", "Setup A")]);
    brokerOrders[0]!.status = "filled";
    brokerOrders[0]!.filled_qty = brokerOrders[0]!.qty;
    positions.set("AAPL", "1");
    await expect(execute([alert("AAPL", "Exit Tier 2")])).rejects.toThrow("differs from strategy ownership");
    expect(brokerOrders).toHaveLength(1);
  });

  it("cancels and replaces only the unfilled quantity at the morning scan", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { execute, brokerOrders, positions } = harness();
    await execute([alert("AAPL", "Setup A")]);
    brokerOrders[0]!.status = "partially_filled";
    brokerOrders[0]!.filled_qty = "1";
    positions.set("AAPL", "1");
    await execute([alert("AAPL", "Setup A")], "morning");
    expect(brokerOrders).toHaveLength(2);
    expect(brokerOrders[0]!.status).toBe("canceled");
    expect(Number(brokerOrders[1]!.qty) + 1).toBeCloseTo(Number(brokerOrders[0]!.qty), 9);
    expect(brokerOrders[1]!.limit_price).toBe("103.00");
    await execute([alert("AAPL", "Setup A")], "morning");
    expect(brokerOrders).toHaveLength(2);
  });
});
