import defaults from "../../backtest.config.json";
import { validateConfig } from "./config";
import type { BacktestConfig } from "./config";

const DEFAULT_CONFIG_NAME = "backtest.config.json";

function configTemplate(value: unknown): BacktestConfig {
  const config = validateConfig(value);
  const source = value as { dateWindow: { end: string } };
  if (source.dateWindow.end === "today") config.dateWindow.end = "today";
  return config;
}

export class ConfigStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec("CREATE TABLE IF NOT EXISTS backtest_configs (name TEXT PRIMARY KEY, config TEXT NOT NULL)");
  }

  load(): BacktestConfig {
    const row = this.sql.exec<{ config: string }>(
      "SELECT config FROM backtest_configs WHERE name = ?", DEFAULT_CONFIG_NAME
    ).toArray()[0];
    if (row) return configTemplate(JSON.parse(row.config));
    return configTemplate(defaults);
  }

  save(value: unknown): BacktestConfig {
    const config = configTemplate(value);
    this.sql.exec(
      "INSERT INTO backtest_configs (name, config) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET config = excluded.config",
      DEFAULT_CONFIG_NAME, JSON.stringify(config)
    );
    return config;
  }
}
