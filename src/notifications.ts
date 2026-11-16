import type { Env, StockAlert } from "./types";

const MAX_MESSAGE_LENGTH = 3_500;
const ALERT_HISTORY_TTL_SECONDS = 90 * 24 * 60 * 60;

function formatAlert(alert: StockAlert): string {
  return [
    `${alert.ticker} | ${alert.type}`,
    `Close $${alert.close.toFixed(2)}`,
    `Stop $${alert.stopLoss.toFixed(2)}`,
    `EMA 20/50/100/200: ${alert.ema20.toFixed(2)} / ${alert.ema50.toFixed(2)} / ${alert.ema100.toFixed(2)} / ${alert.ema200.toFixed(2)}`
  ].join(" | ");
}

function splitMessages(alerts: readonly StockAlert[], date: string): StockAlert[][] {
  const chunks: StockAlert[][] = [];
  let chunk: StockAlert[] = [];
  let length = `Daily stock scan — ${date}\n`.length;

  for (const alert of alerts) {
    const lineLength = formatAlert(alert).length + 1;
    if (chunk.length > 0 && length + lineLength > MAX_MESSAGE_LENGTH) {
      chunks.push(chunk);
      chunk = [];
      length = `Daily stock scan — ${date}\n`.length;
    }
    if (lineLength > MAX_MESSAGE_LENGTH) {
      throw new Error(`Alert for ${alert.ticker} exceeds the webhook message limit.`);
    }
    chunk.push(alert);
    length += lineLength;
  }

  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

function parseAlertHistory(value: string | null): Set<string> {
  if (value === null) return new Set();
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("Stored alert history is invalid.");
  }
  return new Set(parsed);
}

async function postWebhook(message: string, env: Env): Promise<void> {
  if (!env.WEBHOOK_URL) throw new Error("WEBHOOK_URL must be configured before sending alerts.");
  const url = new URL(env.WEBHOOK_URL);
  let body: Record<string, unknown>;

  if (url.hostname === "api.telegram.org") {
    if (!env.TELEGRAM_CHAT_ID) {
      throw new Error("TELEGRAM_CHAT_ID is required when WEBHOOK_URL targets Telegram.");
    }
    body = { chat_id: env.TELEGRAM_CHAT_ID, text: message };
  } else if (url.hostname === "discord.com" || url.hostname === "discordapp.com") {
    body = { embeds: [{ title: "Daily stock scan", description: message }] };
  } else {
    body = { text: message };
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    throw new Error(`Webhook request failed with status ${response.status}.`);
  }
}

export async function sendNewAlerts(
  alerts: readonly StockAlert[],
  date: string,
  env: Env
): Promise<StockAlert[]> {
  if (alerts.length === 0) return [];

  const historyKey = `alerts:${date}`;
  const sentIds = parseAlertHistory(await env.STOCK_TRACKER_KV.get(historyKey));
  const pending = alerts.filter((alert) => !sentIds.has(`${alert.ticker}:${alert.type}`));
  const notified: StockAlert[] = [];

  for (const chunk of splitMessages(pending, date)) {
    const message = [
      `Daily stock scan — ${date}`,
      ...chunk.map(formatAlert)
    ].join("\n");
    await postWebhook(message, env);

    for (const alert of chunk) {
      sentIds.add(`${alert.ticker}:${alert.type}`);
      notified.push(alert);
    }
    await env.STOCK_TRACKER_KV.put(historyKey, JSON.stringify([...sentIds]), {
      expirationTtl: ALERT_HISTORY_TTL_SECONDS
    });
  }

  return notified;
}
