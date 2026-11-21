import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import seed from "../backtest.config.json";
import { validateConfig } from "../src/backtest/config.ts";
import type { BacktestResult } from "../src/backtest/simulator.ts";

const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done, reject) => {
    server.close((error) => error ? reject(error) : done());
    server.closeAllConnections();
  })));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "wtrack-backtest-cli-"));
  directories.push(path);
  return path;
}

function cli(args: string[], cwd = resolve("."), env: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    execFile(process.execPath, ["--disable-warning=DEP0040", "--experimental-strip-types", resolve("scripts/backtest.ts"), ...args],
      { cwd, env, encoding: "utf8", timeout: 15_000 }, (error, stdout, stderr) => {
        done({ code: error ? Number(error.code) || 1 : 0, stdout, stderr });
      });
  });
}

async function api(body: unknown, status = 200) {
  const requests: Array<{ path: string; method?: string; origin?: string; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    requests.push({
      path: request.url!, method: request.method, origin: request.headers.origin,
      body: JSON.parse(text)
    });
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server address.");
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

function result(): BacktestResult {
  return {
    config: validateConfig(seed),
    period: { start: "2022-01-03", end: "2022-01-04", tradingDays: 2 },
    benchmark: { ticker: "VOO", returnPercent: null },
    metrics: {
      startingCapital: 100000, endingEquity: 101000, netProfit: 1000, returnPercent: 1,
      closedTrades: 1, wins: 1, losses: 0, winRatePercent: 100, profitFactor: null,
      maxDrawdownPercent: 0.5, openPositions: 1
    },
    trades: [{
      ticker: "AAPL", setup: "Setup A", entryDate: "2022-01-03", exitDate: "2022-01-04",
      entryPrice: 100, exitPrice: 110, shares: 100, pnl: 1000, returnPercent: 10,
      exitReason: "Profit target"
    }],
    openTrades: [{
      ticker: "NVDA", setup: "Setup D", entryDate: "2022-01-04", entryPrice: 100,
      lastClose: 100, remainingShares: 50, unrealizedPnl: 0
    }],
    equityCurve: [{ date: "2022-01-03", equity: 100000 }, { date: "2022-01-04", equity: 101000 }]
  };
}

describe("backtest terminal command", () => {
  it.each([[1000, 32], [-1000, 31]])("highlights net profit %s while keeping saved logs free of color escapes", async (netProfit, color) => {
    const output = await directory();
    const response = result();
    response.metrics.netProfit = netProfit;
    response.metrics.endingEquity = response.metrics.startingCapital + netProfit;
    response.metrics.returnPercent = netProfit / response.metrics.startingCapital * 100;
    const worker = await api({ result: response });
    const run = await cli(["--url", worker.url, "--output-dir", output], resolve("."), {
      ...process.env, FORCE_COLOR: "1", NO_COLOR: undefined
    });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain(`\u001b[1m\u001b[${color}mNet profit: `);
    const log = (await readdir(output)).find((file) => file.endsWith(".log"))!;
    const text = await readFile(join(output, log), "utf8");
    expect(text).toBe(stripVTControlCharacters(run.stdout));
    expect(text).not.toContain("\u001b");
    expect(text.trimEnd()).toMatch(/Open positions: 1$/);
  });

  it("honors NO_COLOR even when FORCE_COLOR is set", async () => {
    const output = await directory();
    const worker = await api({ result: result() });
    const run = await cli(["--url", worker.url, "--output-dir", output], resolve("."), {
      ...process.env, FORCE_COLOR: "1", NO_COLOR: "1"
    });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).not.toContain("\u001b");
    expect(run.stdout).toContain("Net profit: $1,000.00 (1.00%)");
  });

  it("posts the default draft without saving and writes the terminal report and complete JSON", async () => {
    const output = await directory();
    const response = { result: result(), downloaded: ["AAPL"], cache: [] };
    const worker = await api(response);
    const run = await cli(["--url", worker.url, "--output-dir", output]);
    expect(run.code, run.stderr).toBe(0);
    expect(worker.requests).toEqual([{
      path: "/admin/backtest/run", method: "POST", origin: worker.url, body: { config: seed }
    }]);
    expect(run.stdout).toContain("Net profit: $1,000.00 (1.00%)");
    expect(run.stdout).toContain("VOO return: N/A");
    expect(run.stdout).toContain("Profit factor: N/A");
    expect(run.stdout).toContain("AAPL | Setup A | 2022-01-03 -> 2022-01-04");
    expect(run.stdout).toContain("NVDA | Setup D | 2022-01-04");
    expect(run.stdout.indexOf("Completed trades")).toBeLessThan(run.stdout.indexOf("Open trades"));
    expect(run.stdout.indexOf("Open trades")).toBeLessThan(run.stdout.indexOf("Backtest summary"));
    expect(run.stdout.indexOf("Full results:")).toBeLessThan(run.stdout.indexOf("Backtest summary"));
    expect(run.stdout.trimEnd()).toMatch(/Open positions: 1$/);
    const files = await readdir(output);
    expect(files).toHaveLength(2);
    const text = await readFile(join(output, files.find((file) => file.endsWith(".log"))!), "utf8");
    expect(text).toBe(run.stdout);
    const saved = JSON.parse(await readFile(join(output, files.find((file) => file.endsWith(".json"))!), "utf8"));
    expect(saved).toEqual({ requestedConfig: seed, ...response });
    expect(saved.requestedConfig.dateWindow.end).toBe("today");
  });

  it("reads a custom config and uses the default log directory without overwriting earlier runs", async () => {
    const cwd = await directory();
    const configPath = join(cwd, "custom.json");
    const config = { ...seed, strategy: { ...seed.strategy, setups: [] } };
    await writeFile(configPath, JSON.stringify(config));
    const response = result();
    response.config = validateConfig(config);
    response.trades = [];
    response.openTrades = [];
    const worker = await api({ result: response });
    for (let index = 0; index < 2; index++) {
      const run = await cli(["--config", configPath, "--url", worker.url], cwd);
      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout).toContain("Setups: none");
      expect(run.stdout).toContain("Completed trades\nNone");
      expect(run.stdout).toContain("Open trades\nNone");
    }
    expect(worker.requests.map((request) => request.body)).toEqual([{ config }, { config }]);
    expect(await readdir(join(cwd, "backtest-data", "logs"))).toHaveLength(4);
  });

  it("surfaces API validation failures in the terminal and error log with a nonzero exit", async () => {
    const output = await directory();
    const worker = await api({ error: "strategy.watchlist must contain unique uppercase ticker symbols." }, 400);
    const run = await cli(["--url", worker.url, "--output-dir", output]);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("ERROR: strategy.watchlist");
    const files = await readdir(output);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.log$/);
    expect(await readFile(join(output, files[0]!), "utf8")).toBe(run.stdout);
  });

  it("logs invalid JSON without sending a request", async () => {
    const output = await directory();
    const config = join(output, "bad.json");
    await writeFile(config, "{");
    const worker = await api({ result: result() });
    const run = await cli(["--config", config, "--url", worker.url, "--output-dir", output]);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("ERROR:");
    expect(worker.requests).toHaveLength(0);
    expect((await readdir(output)).filter((file) => file.endsWith(".log"))).toHaveLength(1);
  });

  it("shows help without creating logs and rejects invalid options", async () => {
    const cwd = await directory();
    const help = await cli(["--help"], cwd);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: pnpm backtest:run");
    for (const args of [
      ["--config"], ["--unknown"], ["--url", "https://example.com/admin"],
      ["--url", "https://user:secret@example.com"], ["--config", "a", "--config", "b"]
    ]) {
      const run = await cli(args, cwd);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("ERROR:");
    }
    expect(await readdir(cwd)).toEqual([]);
  });
});
