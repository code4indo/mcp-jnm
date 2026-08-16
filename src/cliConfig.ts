import fs from "fs";
import os from "os";
import path from "path";

export interface ServerProfile {
  name: string;
  url: string;
  headers?: Record<string, string>;
  lastConnected?: string;
}

export interface SessionCacheEntry {
  url: string;
  headers?: Record<string, string>;
  cachedAt: string;
}

export interface CliConfig {
  profiles: Record<string, ServerProfile>;
  sessions: Record<string, SessionCacheEntry>;
}

const CONFIG_DIR = path.join(os.homedir(), ".mcp-jnm");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

const EMPTY_CONFIG: CliConfig = { profiles: {}, sessions: {} };

export function loadCliConfig(): CliConfig {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      return { ...EMPTY_CONFIG, profiles: {}, sessions: {} };
    }
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<CliConfig>;
    return {
      profiles: parsed.profiles || {},
      sessions: parsed.sessions || {},
    };
  } catch (err) {
    console.warn("Failed to load CLI config, using empty config:", (err as Error).message);
    return { profiles: {}, sessions: {} };
  }
}

export function saveCliConfig(cfg: CliConfig): void {
  try {
    ensureConfigDir();
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
  } catch (err) {
    console.warn("Failed to save CLI config:", (err as Error).message);
  }
}

export function saveSessionCache(url: string, headers?: Record<string, string>): void {
  const cfg = loadCliConfig();
  cfg.sessions[url] = {
    url,
    headers,
    cachedAt: new Date().toISOString(),
  };
  saveCliConfig(cfg);
}
