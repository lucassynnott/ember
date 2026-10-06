const { spawn } = require("node:child_process");

class CancelledError extends Error {
  constructor() {
    super("Cancelled.");
    this.cancelled = true;
  }
}

// Script CLIs use Ember's bundled Node runtime, including Electron in Node mode.
// Native binaries are launched directly; arguments never pass through a shell.
function cliCommand(binary, args) {
  if (/\.(?:cjs|mjs|js)$/i.test(binary)) {
    return { binary: process.execPath, args: [binary, ...args], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } };
  }
  return { binary, args, env: process.env };
}

// Runs a CLI and returns its text output. stdin is closed unless `input` is given
// (ntn waits on an open pipe), so nothing ever blocks waiting for a terminal.
function runText(binary, args, { timeoutMs = 60000, onChild, input, env } = {}) {
  return new Promise((resolve, reject) => {
    const command = cliCommand(binary, args);
    const child = spawn(command.binary, command.args, {
      windowsHide: true,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: env ? { ...command.env, ...env } : command.env,
    });
    onChild?.(child);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else {
        const error = new Error((stderr || stdout).trim().split("\n")[0] || `${binary} exited with ${code ?? signal}`);
        error.code = code;
        error.signal = signal;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

module.exports = { CancelledError, runText, cliCommand };
