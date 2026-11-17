import type { Env, StockAlert } from "./types";

const API = "https://paper-api.alpaca.markets/v2";
const BUDGET = 1000;
const MAX_POSITIONS = 5;
const SCALE = 1_000_000_000n;
const TERMINAL = new Set(["filled", "canceled", "expired", "rejected"]);

interface OrderRecord {
  clientId: string;
  ticker: string;
  side: "buy" | "sell";
  signalDate: string;
  phase: "close" | "morning";
  qty: string;
  limit: string;
  status: string;
  filledQty: string;
  id?: string;
  replacementRequested?: boolean;
}

interface TradingRequest {
  date: string;
  phase: "close" | "morning";
  alerts: StockAlert[];
}

function units(value: string): bigint {
  if (!/^\d+(?:\.\d{1,9})?$/.test(value)) throw new Error(`Invalid share quantity: ${value}`);
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(9, "0"));
}

function quantity(value: bigint): string {
  const whole = value / SCALE;
  const fraction = (value % SCALE).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function limitPrice(close: number, side: "buy" | "sell"): string {
  if (!Number.isFinite(close) || close <= 0) throw new Error("Invalid signal close.");
  const raw = close * (side === "buy" ? 1.03 : 0.97);
  const precision = raw >= 1 ? 100 : 10_000;
  const rounded = side === "buy" ? Math.floor(raw * precision + 1e-8) : Math.ceil(raw * precision - 1e-8);
  if (rounded <= 0) throw new Error("Signal close is too small for a limit order.");
  return (rounded / precision).toFixed(precision === 100 ? 2 : 4);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class PaperTrading {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    let release!: () => void;
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/status") {
        return Response.json({ enabled: await this.state.storage.get<boolean>("enabled") === true });
      }
      if (request.method === "POST" && path === "/switch") {
        const value: unknown = await request.json();
        if (!isRecord(value) || typeof value.enabled !== "boolean") {
          return new Response("Invalid switch value", { status: 400 });
        }
        await this.state.storage.put("enabled", value.enabled);
        return Response.json({ enabled: value.enabled });
      }
      if (request.method === "GET" && path === "/symbols") {
        const orders = await this.orders();
        return Response.json({ symbols: this.managedSymbols(orders) });
      }
      if (request.method !== "POST" || path !== "/execute") return new Response("Not found", { status: 404 });
      if (await this.state.storage.get<boolean>("enabled") !== true) {
        return Response.json({ submitted: 0, disabled: true });
      }
      const input = await request.json() as TradingRequest;
      const result = await this.execute(input);
      return Response.json(result);
    } finally {
      release();
    }
  }

  private async orders(): Promise<OrderRecord[]> {
    return await this.state.storage.get<OrderRecord[]>("orders") ?? [];
  }

  private async save(orders: OrderRecord[]): Promise<void> {
    await this.state.storage.put("orders", orders);
  }

  private managedSymbols(orders: OrderRecord[]): string[] {
    const symbols = new Set(orders.map((order) => order.ticker));
    return [...symbols].filter((symbol) =>
      this.owned(orders, symbol) > 0n ||
      orders.some((order) => order.ticker === symbol && !TERMINAL.has(order.status))
    );
  }

  private owned(orders: OrderRecord[], ticker: string): bigint {
    return orders.filter((order) => order.ticker === ticker).reduce((total, order) =>
      total + units(order.filledQty) * (order.side === "buy" ? 1n : -1n), 0n);
  }

  private async api(path: string, init?: RequestInit): Promise<Response> {
    if (!this.env.ALPACA_API_KEY || !this.env.ALPACA_API_SECRET_KEY) {
      throw new Error("Alpaca paper API credentials are required.");
    }
    return fetch(`${API}${path}`, {
      ...init,
      headers: {
        "APCA-API-KEY-ID": this.env.ALPACA_API_KEY,
        "APCA-API-SECRET-KEY": this.env.ALPACA_API_SECRET_KEY,
        "content-type": "application/json"
      },
      signal: AbortSignal.timeout(15_000)
    });
  }

  private async get(path: string): Promise<unknown> {
    const response = await this.api(path);
    if (!response.ok) throw new Error(`Alpaca paper request ${path} failed with status ${response.status}.`);
    return response.json();
  }

  private applyBrokerOrder(record: OrderRecord, value: unknown): void {
    if (!isRecord(value) || typeof value.id !== "string" ||
      value.client_order_id !== record.clientId || value.symbol !== record.ticker ||
      value.side !== record.side || typeof value.status !== "string" ||
      typeof value.filled_qty !== "string") {
      throw new Error(`Invalid Alpaca order response for ${record.clientId}.`);
    }
    const filled = units(value.filled_qty);
    if (filled > units(record.qty) || filled < units(record.filledQty)) {
      throw new Error(`Unexpected filled quantity for ${record.clientId}.`);
    }
    record.id = value.id;
    record.status = value.status;
    record.filledQty = value.filled_qty;
  }

  private async reconcile(orders: OrderRecord[]): Promise<void> {
    for (const order of orders) {
      if (TERMINAL.has(order.status)) continue;
      const value = await this.get(`/orders:by_client_order_id?client_order_id=${encodeURIComponent(order.clientId)}`);
      this.applyBrokerOrder(order, value);
      await this.save(orders);
    }
  }

  private async submit(orders: OrderRecord[], record: OrderRecord): Promise<void> {
    orders.push(record);
    await this.save(orders);
    const response = await this.api("/orders", {
      method: "POST",
      body: JSON.stringify({
        symbol: record.ticker,
        side: record.side,
        type: "limit",
        time_in_force: "day",
        qty: record.qty,
        limit_price: record.limit,
        client_order_id: record.clientId
      })
    });
    if (!response.ok) {
      if ([400, 401, 403, 422].includes(response.status)) {
        record.status = "rejected";
        await this.save(orders);
      }
      // Other failures leave an unresolved intent until Alpaca confirms the order.
      throw new Error(`Alpaca paper order ${record.clientId} returned status ${response.status}.`);
    }
    this.applyBrokerOrder(record, await response.json());
    await this.save(orders);
    if (record.status === "rejected") throw new Error(`Alpaca rejected paper order ${record.clientId}.`);
  }

  private async execute(input: TradingRequest): Promise<{ submitted: number }> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) ||
      (input.phase !== "close" && input.phase !== "morning") || !Array.isArray(input.alerts)) {
      throw new Error("Invalid paper trading request.");
    }
    const account = await this.get("/account");
    if (!isRecord(account) || typeof account.id !== "string" || account.trading_blocked !== false ||
      account.account_blocked !== false) throw new Error("Alpaca paper account is unavailable or blocked.");
    const accountId = await this.state.storage.get<string>("accountId");
    if (accountId && accountId !== account.id) throw new Error("Paper account changed; trading is disabled until reconciled.");
    if (!accountId) await this.state.storage.put("accountId", account.id);
    const orders = await this.orders();
    await this.reconcile(orders);
    const positions = await this.get("/positions");
    const openOrders = await this.get("/orders?status=open&limit=500");
    if (!Array.isArray(positions) || !Array.isArray(openOrders) || openOrders.length >= 500) {
      throw new Error("Unable to verify Alpaca positions and open orders.");
    }
    const brokerPositions = new Map<string, bigint>();
    for (const position of positions) {
      if (!isRecord(position) || typeof position.symbol !== "string" ||
        typeof position.qty !== "string" || position.side !== "long") {
        throw new Error("Unexpected Alpaca position; paper trading stopped.");
      }
      brokerPositions.set(position.symbol, units(position.qty));
    }
    const externalOrders = new Set<string>();
    for (const order of openOrders) {
      if (!isRecord(order) || typeof order.symbol !== "string" || typeof order.client_order_id !== "string") {
        throw new Error("Unexpected open order; paper trading stopped.");
      }
      if (!orders.some((item) => item.clientId === order.client_order_id)) externalOrders.add(order.symbol);
    }
    for (const symbol of this.managedSymbols(orders)) {
      const owned = this.owned(orders, symbol);
      if (owned < 0n || (brokerPositions.get(symbol) ?? 0n) !== owned || externalOrders.has(symbol)) {
        throw new Error(`Paper position ${symbol} differs from strategy ownership; reconcile it manually.`);
      }
    }
    let submitted = 0;
    if (input.phase === "morning") {
      for (const order of [...orders]) {
        if (order.phase !== "close" || order.signalDate !== input.date ||
          order.status === "filled" ||
          orders.some((item) => item.ticker === order.ticker && item.side === order.side &&
            item.signalDate === order.signalDate && item.phase === "morning")) continue;
        if (TERMINAL.has(order.status) && !order.replacementRequested) continue;
        if (!order.id) throw new Error(`Missing broker ID for ${order.clientId}.`);
        if (!TERMINAL.has(order.status)) {
          order.replacementRequested = true;
          await this.save(orders);
          const response = await this.api(`/orders/${encodeURIComponent(order.id)}`, { method: "DELETE" });
          if (!response.ok) throw new Error(`Could not cancel ${order.clientId}: ${response.status}.`);
          for (let attempt = 0; attempt < 10 && !TERMINAL.has(order.status); attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            const value = await this.get(`/orders:by_client_order_id?client_order_id=${encodeURIComponent(order.clientId)}`);
            this.applyBrokerOrder(order, value);
            await this.save(orders);
          }
          if (!TERMINAL.has(order.status)) throw new Error(`Cancellation of ${order.clientId} is still pending.`);
        }
        const remaining = units(order.qty) - units(order.filledQty);
        if (remaining === 0n) continue;
        if (order.status !== "canceled") throw new Error(`Cannot replace ${order.clientId} after status ${order.status}.`);
        const replacement: OrderRecord = {
          clientId: `wtrack-${input.date}-${order.ticker}-${order.side}-morning`,
          ticker: order.ticker, side: order.side, signalDate: input.date,
          phase: "morning", qty: quantity(remaining), limit: order.limit,
          status: "intent", filledQty: "0"
        };
        await this.submit(orders, replacement);
        submitted += 1;
      }
    }
    const signals = new Map<string, StockAlert[]>();
    for (const alert of input.alerts) {
      const group = signals.get(alert.ticker) ?? [];
      group.push(alert);
      signals.set(alert.ticker, group);
    }
    for (const [ticker, alerts] of signals) {
      const exit = alerts.find((alert) => alert.type.startsWith("Exit"));
      const entry = alerts.find((alert) => alert.type === "Setup A" || alert.type === "Setup B");
      const owned = this.owned(orders, ticker);
      const existing = orders.filter((order) => order.ticker === ticker && !TERMINAL.has(order.status));
      if (exit && existing.some((order) => order.side === "buy")) {
        throw new Error(`Pending paper entry for ${ticker} prevents its exit; cancel and reconcile it.`);
      }
      const side = exit && owned > 0n ? "sell" : !exit && entry && owned === 0n ? "buy" : null;
      if (!side) continue;
      const alert = side === "sell" ? exit! : entry!;
      if (alert.date !== input.date || externalOrders.has(ticker)) continue;
      if (side === "buy" && ((brokerPositions.get(ticker) ?? 0n) > 0n ||
        this.managedSymbols(orders).length >= MAX_POSITIONS)) continue;
      if (existing.length > 0) continue;
      const clientId = `wtrack-${input.date}-${ticker}-${side}-${input.phase}`;
      if (orders.some((order) => order.clientId === clientId ||
        (order.ticker === ticker && order.side === side && order.signalDate === input.date))) continue;
      const limit = limitPrice(alert.close, side);
      let qty = owned;
      if (side === "buy") {
        const asset = await this.get(`/assets/${encodeURIComponent(ticker)}`);
        if (!isRecord(asset) || asset.tradable !== true || typeof asset.fractionable !== "boolean") {
          throw new Error(`Cannot verify that ${ticker} is tradable.`);
        }
        const [whole, fraction = ""] = limit.split(".");
        const priceUnits = BigInt(whole!) * 10_000n + BigInt(fraction.padEnd(4, "0"));
        qty = BigInt(BUDGET) * 10_000n * SCALE / priceUnits;
        if (!asset.fractionable) qty = (qty / SCALE) * SCALE;
      }
      if (qty <= 0n) throw new Error(`Unable to size paper order for ${ticker}.`);
      await this.submit(orders, {
        clientId, ticker, side, signalDate: input.date, phase: input.phase,
        qty: quantity(qty), limit, status: "intent", filledQty: "0"
      });
      submitted += 1;
    }
    return { submitted };
  }
}
