import { createInterface } from "node:readline/promises";
import { stdin, stderr } from "node:process";

export class PromptCancelledError extends Error {
  constructor() {
    super("Sign-in was cancelled.");
    this.name = "PromptCancelledError";
    this.code = "cancelled";
  }
}

export async function promptLine(label, options = {}) {
  const input = options.input ?? stdin;
  const output = options.output ?? stderr;
  if (options.hidden) return promptHidden(label, { input, output });
  if (!input.isTTY) throw new Error("Interactive input requires a terminal.");
  const terminal = createInterface({ input, output, terminal: true });
  try {
    return (await terminal.question(label)).trim();
  } finally {
    terminal.close();
  }
}

export function promptHidden(label, options = {}) {
  const input = options.input ?? stdin;
  const output = options.output ?? stderr;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("A terminal is required for hidden input.");
  }
  output.write(label);
  return new Promise((resolvePromise, reject) => {
    let value = "";
    const wasRaw = Boolean(input.isRaw);
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      input.pause();
    };
    const finish = (callback, result) => {
      cleanup();
      output.write("\n");
      callback(result);
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === "\u0003") {
          finish(reject, new PromptCancelledError());
          return;
        }
        if (character === "\r" || character === "\n") {
          finish(resolvePromise, value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " " && character !== "\u007f") value += character;
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

export async function readExactlyOneLine(input = stdin) {
  let value = "";
  for await (const chunk of input) value += String(chunk);
  const normalized = value.replace(/\r\n/g, "\n");
  const lines = normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n");
  if (lines.length !== 1 || !lines[0]) {
    throw new Error("--password-stdin expects exactly one non-empty password line.");
  }
  return lines[0];
}
