import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { styleText } from "node:util";
import type { BacktestResult } from "../src/backtest/simulator.ts";
import { withBacktestWorker } from "./backtest-worker.ts";

const HELP = `Usage: pnpm backtest:run [options]

Run a draft configuration through WTrack's existing backtest API.
Automatically starts and stops a local Worker unless --url is specified.

  --config <file>      Configuration JSON (default: backtest.config.json)
  --url <origin>       Use an existing Worker instead of starting one
  --output-dir <dir>   Log directory (default: backtest-data/logs)
  --help              Show this help

Writes a terminal report, a matching .log, and the full response in .json.
Net profit is bold and colored in terminals; log files remain plain text.
Does not save configuration or submit orders.`;

function options(args: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === "--help" && args.length === 1) return null;
    if (!["--config", "--url", "--output-dir"].includes(flag)) {
      throw new Error(`Unknown option: ${flag}. Use --help for usage.`);
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    if (values.has(flag)) throw new Error(`${flag} may only be specified once.`);
    values.set(flag, value);
  }
  const url = values.has("--url") ? new URL(values.get("--url")!) : null;
  if (url && (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
    url.pathname !== "/" || url.search || url.hash)) {
    throw new Error("--url must be an HTTP(S) origin without credentials, a path, query, or fragment.");
  }
  return {
    config: resolve(values.get("--config") ?? "backtest.config.json"),
    url,
    outputDir: resolve(values.get("--output-dir") ?? "backtest-data/logs")
  };
}

function report(result: BacktestResult): string {
  const money = (value: number) => value.toLocaleString("en-US", {
    style: "currency", currency: "USD"
  });
  const percent = (value: number) => `${value.toFixed(2)}%`;
  const { metrics, period, benchmark } = result;
  return [
    "",
    "Completed trades",
    ...result.trades.map((trade) =>
      `${trade.ticker} | ${trade.setup} | ${trade.entryDate} -> ${trade.exitDate} | ` +
      `entry ${money(trade.entryPrice)} | exit ${money(trade.exitPrice)} | shares ${trade.shares} | ` +
      `P&L ${money(trade.pnl)} (${percent(trade.returnPercent)}) | ${trade.exitReason}`),
    ...(result.trades.length ? [] : ["None"]),
    "",
    "Open trades",
    ...result.openTrades.map((trade) =>
      `${trade.ticker} | ${trade.setup} | ${trade.entryDate} | entry ${money(trade.entryPrice)} | ` +
      `last close ${money(trade.lastClose)} | shares ${trade.remainingShares} | ` +
      `unrealized P&L ${money(trade.unrealizedPnl)}`),
    ...(result.openTrades.length ? [] : ["None"]),
    "",
    "Backtest summary",
    `Requested: ${result.config.dateWindow.start} to ${result.config.dateWindow.end}`,
    `Simulated: ${period.start ?? "N/A"} to ${period.end ?? "N/A"} (${period.tradingDays} trading days)`,
    `Setups: ${result.config.strategy.setups.join(", ") || "none"}`,
    `Watchlist: ${result.config.strategy.watchlist.join(", ")}`,
    `Starting capital: ${money(metrics.startingCapital)}`,
    `Ending equity: ${money(metrics.endingEquity)}`,
    `Net profit: ${money(metrics.netProfit)} (${percent(metrics.returnPercent)})`,
    `VOO return: ${benchmark.returnPercent === null ? "N/A" : percent(benchmark.returnPercent)}`,
    `Max drawdown: ${percent(metrics.maxDrawdownPercent)}`,
    `Closed trades: ${metrics.closedTrades} (${metrics.wins} wins, ${metrics.losses} losses)`,
    `Win rate: ${percent(metrics.winRatePercent)}`,
    `Profit factor: ${metrics.profitFactor === null ? "N/A" : metrics.profitFactor.toFixed(2)}`,
    `Open positions: ${metrics.openPositions}`
  ].join("\n");
}

async function main() {
  const settings = options(process.argv.slice(2));
  if (!settings) {
    console.log(HELP);
    return;
  }
  await mkdir(settings.outputDir, { recursive: true });
  const name = `backtest-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const textPath = resolve(settings.outputDir, `${name}.log`);
  const jsonPath = resolve(settings.outputDir, `${name}.json`);
  await writeFile(textPath, "", { flag: "wx" });
  const colorEnabled = process.env.NO_COLOR === undefined && process.env.FORCE_COLOR !== "0" &&
    (Boolean(process.stdout.isTTY) || process.env.FORCE_COLOR !== undefined);
  const log = async (message: string, netProfit?: number) => {
    await appendFile(textPath, `${message}\n`);
    console.log(colorEnabled && netProfit !== undefined
      ? message.replace(/^Net profit:.*$/m, (line) =>
        styleText(["bold", netProfit < 0 ? "red" : "green"], line, { validateStream: false }))
      : message);
  };
  try {
    await log(`Config: ${settings.config}\nLog: ${textPath}`);
    const config: unknown = JSON.parse(await readFile(settings.config, "utf8"));
    if (!settings.url) await log("Starting local backtest Worker...");
    await withBacktestWorker(settings.url, async (url, signal) => {
      await log(`Worker: ${url.origin}`);
      await log("Running backtest (downloading missing history if needed)...");
      let response: Response;
      try {
        response = await fetch(new URL("/admin/backtest/run", url), {
          method: "POST",
          headers: { "content-type": "application/json", origin: url.origin },
          body: JSON.stringify({ config }),
          redirect: "error",
          signal
        });
      } catch {
        signal.throwIfAborted();
        throw new Error("Could not reach the backtest API. Check Worker startup, --url, and Worker access.");
      }
      let body: { result?: BacktestResult; error?: string };
      try {
        body = await response.json() as typeof body;
      } catch {
        signal.throwIfAborted();
        throw new Error(`Backtest API returned non-JSON (HTTP ${response.status}). Check --url and Worker access.`);
      }
      if (!response.ok) throw new Error(body?.error || `Backtest API failed (HTTP ${response.status}).`);
      if (!body?.result) throw new Error("Backtest API response is missing a result.");
      const summary = report(body.result);
      await writeFile(jsonPath, JSON.stringify({
        requestedConfig: config,
        ...body
      }, null, 2) + "\n", { flag: "wx" });
      await log(`\nFull results: ${jsonPath}`);
      await log(summary, body.result.metrics.netProfit);
    });
  } catch (error) {
    await log(`ERROR: ${error instanceof Error ? error.message : "Backtest failed."}`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(`ERROR: ${error instanceof Error ? error.message : "Backtest failed."}`);
  process.exitCode = 1;
});
