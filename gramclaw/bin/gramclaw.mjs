#!/usr/bin/env node

import { runCli } from "../src/cli.js";

runCli(process.argv).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`gramclaw: ${message}\n`);
  if (process.env.GRAMCLAW_DEBUG === "1" && error instanceof Error) {
    process.stderr.write(`${error.stack ?? ""}\n`);
  }
  process.exitCode = 1;
});
