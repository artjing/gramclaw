import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPaths } from "./config.js";

export const INSTAGRAPI_VERSION = "2.18.12";
const RUNTIME_SCHEMA = 1;
const PYTHON_ROOT = fileURLToPath(new URL("../python", import.meta.url));
const SIDECAR_PATH = join(PYTHON_ROOT, "gramclaw_instagram.py");
const REQUIREMENTS_PATH = join(PYTHON_ROOT, "requirements.lock");

export class RuntimeUnavailableError extends Error {
  constructor(message = "Python 3.10+ is required for direct Instagram sign-in.") {
    super(message);
    this.name = "RuntimeUnavailableError";
    this.code = "runtime_unavailable";
  }
}

export function requirementsDigest() {
  return createHash("sha256").update(readFileSync(REQUIREMENTS_PATH)).digest("hex");
}

export function instagramRuntimePaths() {
  const runtimeRoot = join(getPaths().rootDir, "runtime", "instagram-auth");
  const installDir = join(runtimeRoot, INSTAGRAPI_VERSION);
  return {
    runtimeRoot,
    installDir,
    markerPath: join(installDir, "runtime.json"),
    pythonPath: process.platform === "win32"
      ? join(installDir, "Scripts", "python.exe")
      : join(installDir, "bin", "python"),
    lockPath: join(runtimeRoot, ".setup.lock"),
  };
}

export function configuredSidecar(options = {}) {
  const sidecarPath = options.sidecarPath ?? process.env.GRAMCLAW_INSTAGRAM_SIDECAR;
  if (!sidecarPath) return null;
  const pythonPath = locatePython(options);
  return { pythonPath, sidecarPath, prepared: true, override: true };
}

export function locatePython(options = {}) {
  const candidates = [
    options.pythonPath,
    process.env.GRAMCLAW_INSTAGRAM_PYTHON,
    "python3.14",
    "python3.13",
    "python3.12",
    "python3.11",
    "python3.10",
    "python3",
    "python",
  ].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    const result = spawnSync(candidate, [
      "-c",
      "import json,sys;print(json.dumps(list(sys.version_info[:3])))",
    ], {
      encoding: "utf8",
      env: runtimeEnvironment(),
      timeout: 5_000,
    });
    if (result.status !== 0) continue;
    try {
      const [major, minor] = JSON.parse(result.stdout.trim());
      if (major === 3 && minor >= 10) return candidate;
    } catch {
      // Try the next interpreter without surfacing raw process output.
    }
  }
  throw new RuntimeUnavailableError();
}

export function inspectInstagramRuntime(options = {}) {
  const override = configuredSidecar(options);
  if (override) return override;
  const paths = instagramRuntimePaths();
  if (!isPrepared(paths)) {
    throw new RuntimeUnavailableError(
      "The secure Instagram runtime is not prepared. Run `gramclaw login` to install it.",
    );
  }
  return { pythonPath: paths.pythonPath, sidecarPath: SIDECAR_PATH, prepared: true };
}

export async function prepareInstagramRuntime(options = {}) {
  const override = configuredSidecar(options);
  if (override) return override;
  const paths = instagramRuntimePaths();
  if (isPrepared(paths)) {
    return { pythonPath: paths.pythonPath, sidecarPath: SIDECAR_PATH, prepared: true };
  }
  options.onState?.("preparing_runtime");
  const bootstrapPython = locatePython(options);
  mkdirSync(paths.runtimeRoot, { recursive: true, mode: 0o700 });
  await acquireSetupLock(paths);
  let temporary;
  let stale;
  try {
    if (isPrepared(paths)) {
      return { pythonPath: paths.pythonPath, sidecarPath: SIDECAR_PATH, prepared: true };
    }
    temporary = join(paths.runtimeRoot, `.building-${randomUUID()}`);
    await runCommand(bootstrapPython, ["-m", "venv", temporary], { timeout: 120_000 });
    const temporaryPython = process.platform === "win32"
      ? join(temporary, "Scripts", "python.exe")
      : join(temporary, "bin", "python");
    await runCommand(temporaryPython, [
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "--require-hashes",
      "--no-input",
      "-r",
      REQUIREMENTS_PATH,
    ], { timeout: 600_000 });
    writeFileSync(join(temporary, "runtime.json"), `${JSON.stringify({
      schema: RUNTIME_SCHEMA,
      instagrapi: INSTAGRAPI_VERSION,
      requirementsSha256: requirementsDigest(),
    }, null, 2)}\n`, { mode: 0o600 });
    if (existsSync(paths.installDir)) {
      stale = join(paths.runtimeRoot, `.stale-${randomUUID()}`);
      renameSync(paths.installDir, stale);
    }
    renameSync(temporary, paths.installDir);
    temporary = undefined;
    if (stale) {
      try {
        rmSync(stale, { recursive: true, force: true });
      } catch {
        // The active runtime is already installed; stale cache cleanup can wait.
      }
      stale = undefined;
    }
  } catch (error) {
    throw new RuntimeUnavailableError(
      error instanceof RuntimeUnavailableError
        ? error.message
        : "Could not prepare the secure Instagram sign-in runtime.",
    );
  } finally {
    if (temporary && existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
    rmSync(paths.lockPath, { recursive: true, force: true });
  }
  return { pythonPath: paths.pythonPath, sidecarPath: SIDECAR_PATH, prepared: true };
}

function isPrepared(paths) {
  if (!existsSync(paths.pythonPath) || !existsSync(paths.markerPath)) return false;
  try {
    const marker = JSON.parse(readFileSync(paths.markerPath, "utf8"));
    return marker.schema === RUNTIME_SCHEMA
      && marker.instagrapi === INSTAGRAPI_VERSION
      && marker.requirementsSha256 === requirementsDigest();
  } catch {
    return false;
  }
}

async function acquireSetupLock(paths) {
  const deadline = Date.now() + 180_000;
  while (true) {
    try {
      mkdirSync(paths.lockPath, { mode: 0o700 });
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(paths.lockPath).mtimeMs > 900_000) {
          rmSync(paths.lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Another process may have just released the lock.
      }
      if (Date.now() >= deadline) {
        throw new RuntimeUnavailableError("Timed out waiting for another Gramclaw runtime setup.");
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
      if (isPrepared(paths)) return;
    }
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: dirname(REQUIREMENTS_PATH),
      env: runtimeEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new RuntimeUnavailableError("Secure runtime setup timed out."));
    }, options.timeout ?? 120_000);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 8_192) stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8_192) stderr += String(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new RuntimeUnavailableError("Secure runtime setup command failed."));
    });
  });
}

function runtimeEnvironment() {
  const names = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "SYSTEMROOT",
  ];
  return Object.fromEntries(names.filter((name) => process.env[name]).map((name) => [name, process.env[name]]));
}
