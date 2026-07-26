import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

let homeOverride;

const DEFAULT_CONFIG = {
  transport: { preferred: "auto", graphVersion: "v24.0" },
  server: { host: "127.0.0.1", port: 4667 },
  backup: { autoSync: false, staleAfterSeconds: 900 },
  auth: {},
};

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
    runtimeDir: join(rootDir, "runtime"),
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
    return mergeDefaults(DEFAULT_CONFIG, JSON.parse(readFileSync(configPath, "utf8")));
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(nextConfig) {
  const { configPath } = ensureDirs();
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, { mode: 0o600 });
  chmodSync(configPath, 0o600);
  return nextConfig;
}

export function updateConfig(mutator) {
  const current = loadConfig();
  const next = mutator(structuredClone(current)) ?? current;
  return saveConfig(next);
}

export function getInstagramAuthMetadata() {
  return loadConfig().auth?.instagram ?? null;
}

export function setInstagramAuthMetadata(metadata) {
  const safe = {
    credentialId: String(metadata.credentialId),
    username: String(metadata.username).replace(/^@/, ""),
    userId: String(metadata.userId),
    connectedAt: String(metadata.connectedAt),
    ...(metadata.lastVerifiedAt ? { lastVerifiedAt: String(metadata.lastVerifiedAt) } : {}),
  };
  return updateConfig((config) => {
    config.auth ??= {};
    config.auth.instagram = safe;
    return config;
  });
}

export function clearInstagramAuthMetadata() {
  return updateConfig((config) => {
    if (config.auth) delete config.auth.instagram;
    return config;
  });
}

function mergeDefaults(defaults, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return structuredClone(defaults);
  }
  const result = structuredClone(value);
  for (const [key, fallback] of Object.entries(defaults)) {
    if (result[key] === undefined) {
      result[key] = structuredClone(fallback);
    } else if (
      fallback
      && typeof fallback === "object"
      && !Array.isArray(fallback)
    ) {
      result[key] = mergeDefaults(fallback, result[key]);
    }
  }
  return result;
}
