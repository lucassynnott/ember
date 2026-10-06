const { supportDirectory } = require("./platform");
// Connects other AI apps to Ember: the ember command for Terminal, and the MCP
// server entry for Claude Desktop, Claude Code and Cursor. Other apps' config files are changed
// only when you click Connect, and the previous file is kept as a .bak beside it.
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const SERVER_NAME = "ember";
// What the app was called before it was Ember. Entries and commands it installed under this name keep
// working: they're repointed at the app on every start.
const OLD_SERVER_NAME = "meeting-notes";
const MARKERS = ["Installed by Ember", "Installed by Meeting Notes"];

/** How to start the CLI: the app's own binary in Node mode, running src/cli.js from the app. */
function launchSpec({ execPath, appPath }) {
  return { command: execPath, script: path.join(appPath, "src", "cli.js"), env: { ELECTRON_RUN_AS_NODE: "1" } };
}

function cliScript(spec, { platform = process.platform } = {}) {
  if (platform === "win32") {
    const quote = (value) => `"${String(value).replace(/%/g, "%%")}"`;
    return `@echo off\r\nrem Installed by Ember. Search your calls: ember --help\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n${quote(spec.command)} ${quote(spec.script)} %*\r\nexit /b %ERRORLEVEL%\r\n`;
  }
  const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh\n# Installed by Ember. Search your calls: ember --help\nELECTRON_RUN_AS_NODE=1 exec ${quote(spec.command)} ${quote(spec.script)} "$@"\n`;
}

function cliPath(home = os.homedir(), name = "ember") {
  return path.join(home, ".local", "bin", process.platform === "win32" ? `${name}.cmd` : name);
}

const madeByUs = (text) => MARKERS.some((marker) => String(text || "").includes(marker));

async function installCli(spec, { home = os.homedir(), pathEnv = process.env.PATH || "" } = {}) {
  const target = cliPath(home);
  const existing = await fs.readFile(target, "utf8").catch(() => null);
  if (existing !== null && !madeByUs(existing)) {
    throw new Error(`${target} already exists and wasn't made by Ember, so it was left alone.`);
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, cliScript(spec), { mode: 0o755 });
  await fs.chmod(target, 0o755);
  return { path: target, onPath: pathEnv.split(path.delimiter).includes(path.dirname(target)) };
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
  "claude-desktop": { label: "Claude Desktop", bundle: "Claude.app", file: (home) => path.join(supportDirectory("Claude", { home, env: home === os.homedir() ? process.env : {} }), "claude_desktop_config.json") },
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
    connected = [SERVER_NAME, OLD_SERVER_NAME].some((name) => {
      const entry = data.mcpServers?.[name];
      return Boolean(entry) && JSON.stringify(entry) === JSON.stringify(serverEntry(spec));
    });
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
  if (exists && (data.mcpServers?.[SERVER_NAME] || data.mcpServers?.[OLD_SERVER_NAME])) {
    await fs.copyFile(file, `${file}.bak`);
    delete data.mcpServers[SERVER_NAME];
    delete data.mcpServers[OLD_SERVER_NAME];
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
      ? `claude mcp add ${SERVER_NAME} -s user -- ember mcp`
      : `claude mcp add ${SERVER_NAME} -s user -e ELECTRON_RUN_AS_NODE=1 -- ${quote(spec.command)} ${quote(spec.script)} mcp`,
    json: JSON.stringify({ mcpServers: { [SERVER_NAME]: serverEntry(spec) } }, null, 2),
  };
}

// After an update or the rename, the app's binary has a new path. Commands and app entries this app
// installed (under either name) are rewritten to point at it; nothing else is touched.
async function refreshConnections(spec, home = os.homedir()) {
  const changed = [];
  for (const name of ["ember", "meeting-notes"]) {
    const target = cliPath(home, name);
    const existing = await fs.readFile(target, "utf8").catch(() => null);
    if (existing !== null && madeByUs(existing) && existing !== cliScript(spec)) {
      await fs.writeFile(target, cliScript(spec), { mode: 0o755 });
      changed.push(target);
    }
  }
  for (const id of Object.keys(CLIENTS)) {
    const file = CLIENTS[id].file(home);
    let data;
    try {
      ({ data } = await readJson(file));
    } catch {
      continue;
    }
    let touched = false;
    for (const name of [SERVER_NAME, OLD_SERVER_NAME]) {
      const entry = data.mcpServers?.[name];
      const command = String(entry?.command || "").replace(/\\/g, "/");
      const script = String(entry?.args?.[0] || "").replace(/\\/g, "/");
      const ours = entry && Array.isArray(entry.args) && /app\.asar\/src\/(cli|mcp-server)\.js$/.test(script)
        && (/\.app\/Contents\/MacOS\//.test(command) || /\/(Ember|Meeting Notes)\.exe$/i.test(command));
      if (ours && JSON.stringify(entry) !== JSON.stringify(serverEntry(spec))) {
        data.mcpServers[name] = serverEntry(spec);
        touched = true;
      }
    }
    if (touched) {
      await fs.copyFile(file, `${file}.bak`);
      await fs.writeFile(`${file}.tmp`, `${JSON.stringify(data, null, 2)}\n`);
      await fs.rename(`${file}.tmp`, file);
      changed.push(file);
    }
  }
  return changed;
}

module.exports = { CLIENTS, OLD_SERVER_NAME, SERVER_NAME, cliInstalled, refreshConnections, cliPath, cliScript, clientStatus, connectClient, disconnectClient, installCli, launchSpec, serverEntry, snippets };
