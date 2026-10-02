// Connects other AI apps to Meeting Notes: the meeting-notes command for Terminal, and the MCP
// server entry for Claude Desktop, Claude Code and Cursor. Other apps' config files are changed
// only when you click Connect, and the previous file is kept as a .bak beside it.
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const SERVER_NAME = "meeting-notes";

/** How to start the CLI: the app's own binary in Node mode, running src/cli.js from the app. */
function launchSpec({ execPath, appPath }) {
  return { command: execPath, script: path.join(appPath, "src", "cli.js"), env: { ELECTRON_RUN_AS_NODE: "1" } };
}

function cliScript(spec) {
  const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh\n# Installed by Meeting Notes. Search your calls: meeting-notes --help\nELECTRON_RUN_AS_NODE=1 exec ${quote(spec.command)} ${quote(spec.script)} "$@"\n`;
}

function cliPath(home = os.homedir()) {
  return path.join(home, ".local", "bin", "meeting-notes");
}

async function installCli(spec, { home = os.homedir(), pathEnv = process.env.PATH || "" } = {}) {
  const target = cliPath(home);
  const existing = await fs.readFile(target, "utf8").catch(() => null);
  if (existing !== null && !existing.includes("Installed by Meeting Notes")) {
    throw new Error(`${target} already exists and wasn't made by Meeting Notes, so it was left alone.`);
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, cliScript(spec), { mode: 0o755 });
  await fs.chmod(target, 0o755);
  return { path: target, onPath: pathEnv.split(":").includes(path.dirname(target)) };
}

async function cliInstalled(spec, home = os.homedir()) {
  try {
    return (await fs.readFile(cliPath(home), "utf8")) === cliScript(spec);
  } catch {
    return false;
  }
}

function serverEntry(spec) {
  return { command: spec.command, args: [spec.script, "mcp"], env: spec.env };
}

const CLIENTS = {
  "claude-desktop": { label: "Claude Desktop", bundle: "Claude.app", file: (home) => path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json") },
  cursor: { label: "Cursor", bundle: "Cursor.app", file: (home) => path.join(home, ".cursor", "mcp.json") },
};

async function readJson(file) {
  try {
    return { data: JSON.parse(await fs.readFile(file, "utf8")), exists: true };
  } catch (error) {
    if (error.code === "ENOENT") return { data: {}, exists: false };
    throw new Error(`${path.basename(file)} isn't valid JSON, so it was left alone. Fix it or add the server by hand.`);
  }
}

async function clientStatus(id, spec, home = os.homedir()) {
  const client = CLIENTS[id];
  const file = client.file(home);
  const exists = (candidate) =>
    fs
      .access(candidate)
      .then(() => true)
      .catch(() => false);
  const installed =
    (await exists(path.join("/Applications", client.bundle))) ||
    (await exists(path.join(home, "Applications", client.bundle))) ||
    (await exists(path.dirname(file)));
  let connected = false;
  try {
    const { data } = await readJson(file);
    const entry = data.mcpServers?.[SERVER_NAME];
    connected = Boolean(entry) && JSON.stringify(entry) === JSON.stringify(serverEntry(spec));
  } catch {
    connected = false;
  }
  return { id, label: client.label, file, installed, connected };
}

async function connectClient(id, spec, home = os.homedir()) {
  const client = CLIENTS[id];
  if (!client) throw new Error("Unknown app.");
  const file = client.file(home);
  const { data, exists } = await readJson(file);
  if (exists) await fs.copyFile(file, `${file}.bak`);
  data.mcpServers = { ...(data.mcpServers || {}), [SERVER_NAME]: serverEntry(spec) };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.tmp`, `${JSON.stringify(data, null, 2)}\n`);
  await fs.rename(`${file}.tmp`, file);
  return clientStatus(id, spec, home);
}

async function disconnectClient(id, spec, home = os.homedir()) {
  const file = CLIENTS[id].file(home);
  const { data, exists } = await readJson(file);
  if (exists && data.mcpServers?.[SERVER_NAME]) {
    await fs.copyFile(file, `${file}.bak`);
    delete data.mcpServers[SERVER_NAME];
    await fs.writeFile(`${file}.tmp`, `${JSON.stringify(data, null, 2)}\n`);
    await fs.rename(`${file}.tmp`, file);
  }
  return clientStatus(id, spec, home);
}

/** Copyable setup text for apps that are set up by hand. */
function snippets(spec, { cliOnPath = false } = {}) {
  const quote = (value) => (/^[\w./-]+$/.test(value) ? value : `"${value}"`);
  return {
    claudeCode: cliOnPath
      ? `claude mcp add ${SERVER_NAME} -s user -- meeting-notes mcp`
      : `claude mcp add ${SERVER_NAME} -s user -e ELECTRON_RUN_AS_NODE=1 -- ${quote(spec.command)} ${quote(spec.script)} mcp`,
    json: JSON.stringify({ mcpServers: { [SERVER_NAME]: serverEntry(spec) } }, null, 2),
  };
}

module.exports = { CLIENTS, SERVER_NAME, cliInstalled, cliPath, cliScript, clientStatus, connectClient, disconnectClient, installCli, launchSpec, serverEntry, snippets };
