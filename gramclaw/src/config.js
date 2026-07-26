import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

let homeOverride;

export function setHomeOverride(value) {
  homeOverride = value ? resolve(value) : undefined;
}

export function getPaths() {
  const rootDir = homeOverride
    ?? (process.env.GRAMCLAW_HOME ? resolve(process.env.GRAMCLAW_HOME) : join(homedir(), ".gramclaw"));
  return {
    rootDir,
    dbPath: join(rootDir, "gramclaw.sqlite"),
    configPath: join(rootDir, "config.json"),
    mediaDir: join(rootDir, "media"),
    mediaOriginalsDir: join(rootDir, "media", "originals"),
    mediaThumbsDir: join(rootDir, "media", "thumbs"),
    backupsDir: join(rootDir, "backups"),
    auditDir: join(rootDir, "audit"),
    logsDir: join(rootDir, "logs"),
  };
}

export function ensureDirs() {
  const paths = getPaths();
  for (const path of [
    paths.rootDir,
    paths.mediaDir,
    paths.mediaOriginalsDir,
    paths.mediaThumbsDir,
    paths.backupsDir,
    paths.auditDir,
    paths.logsDir,
  ]) {
    mkdirSync(path, { recursive: true });
  }
  return paths;
}

export function loadConfig() {
  const { configPath } = ensureDirs();
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return {
      transport: { preferred: "auto", graphVersion: "v24.0" },
      server: { host: "127.0.0.1", port: 4667 },
      backup: { autoSync: false, staleAfterSeconds: 900 },
    };
  }
}

export function saveConfig(nextConfig) {
  const { configPath } = ensureDirs();
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, { mode: 0o600 });
  return nextConfig;
}

export function updateConfig(mutator) {
  const current = loadConfig();
  const next = mutator(structuredClone(current)) ?? current;
  return saveConfig(next);
}
