const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { formatMeetingNote } = require("../src/note");
const { MeetingNotesTools, handleMessage, serve } = require("../src/mcp-server");
const { run, parse } = require("../src/cli");
const aiConnect = require("../src/ai-connect");

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-"));
  const notes = path.join(root, "notes");
  await fs.mkdir(notes);
  const calls = [
    ["2026-09-29-1605", "Acme renewal call", ["Acme wants a two-year term with quarterly billing."], [["Alex Rivera", "Send the security questionnaire"]], "Alex Rivera: Can we offer quarterly billing?\nPriya Shah: Yes, finance approved it."],
    ["2026-10-01-1100", "Launch plan for October", ["Launch confirmed for 14 October."], [["Sam Okafor", "Schedule the launch email"]], "Sam Okafor: The launch email goes out Monday.\nAlex Rivera: Great."],
  ];
  for (const [stem, title, summary, actions, transcript] of calls) {
    const [y, mo, d, hm] = stem.split("-");
    const startedAt = new Date(Number(y), Number(mo) - 1, Number(d), Number(hm.slice(0, 2)), Number(hm.slice(2)));
    await fs.writeFile(
      path.join(notes, `${stem}.md`),
      formatMeetingNote({
        startedAt,
        endedAt: new Date(startedAt.getTime() + 30 * 60000),
        transcript,
        audioFileName: `${stem}.webm`,
        analysis: { title, summary, decisions: [], actionItems: actions.map(([owner, task]) => ({ owner, task })), transcriptionProvider: "Phonon-2", summaryProvider: "OpenRouter" },
      }),
    );
  }
  await fs.writeFile(path.join(root, "settings.json"), JSON.stringify({ notesDir: notes }));
  await fs.writeFile(path.join(root, "library.json"), JSON.stringify({ folders: [{ id: "f1", name: "Clients" }], meetings: { "2026-09-29-1605": { folderId: "f1", tags: ["sales"] } } }));
  return { root, tools: new MeetingNotesTools({ folder: root }) };
}

test("the MCP tools search, list, open and gather action items read only", async () => {
  const { root, tools } = await fixture();
  const found = await tools.search_meetings({ query: "quarterly billing" });
  assert.match(found, /Acme renewal call \(id: 2026-09-29-1605\).*Clients.*#sales/);
  assert.doesNotMatch(found, /Launch plan/);

  const listed = await tools.list_meetings({ from: "2026-10-01" });
  assert.match(listed, /Launch plan for October/);
  assert.doesNotMatch(listed, /Acme/);
  assert.match(await tools.list_meetings({ folder: "clients" }), /Acme/);
  assert.match(await tools.list_meetings({ folder: "Nope" }), /no folder called/);

  const meeting = await tools.get_meeting({ id: "2026-09-29-1605" });
  assert.match(meeting, /## Transcript\nAlex Rivera: Can we offer quarterly billing\?/);
  assert.doesNotMatch(await tools.get_meeting({ id: "2026-09-29-1605", include_transcript: false }), /## Transcript/);

  const actions = await tools.get_action_items({ owner: "sam" });
  assert.match(actions, /Sam Okafor: Schedule the launch email/);
  assert.doesNotMatch(actions, /questionnaire/);
  assert.match(await tools.search_knowledge({ query: "pricing" }), /knowledge base is empty/);
  await assert.rejects(tools.list_meetings({ from: "last week" }), /isn't a date/);
  await fs.rm(root, { recursive: true, force: true });
});

test("the server speaks JSON-RPC: initialize, tools/list, tools/call and errors", async () => {
  const { root, tools } = await fixture();
  const init = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, tools);
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, tools), null);
  const list = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, tools);
  assert.deepEqual(list.result.tools.map((tool) => tool.name), ["search_meetings", "list_meetings", "get_meeting", "get_action_items", "search_knowledge"]);
  const call = await handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_meeting", arguments: { id: "nope" } } }, tools);
  assert.equal(call.result.isError, true);
  assert.equal((await handleMessage({ jsonrpc: "2.0", id: 4, method: "resources/list" }, tools)).error.code, -32601);

  // Over stdio, one JSON message per line, and nothing for notifications.
  const input = new PassThrough();
  const output = new PassThrough();
  serve({ input, output, tools });
  const replies = [];
  output.on("data", (chunk) => replies.push(...String(chunk).trim().split("\n")));
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  input.write('{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"search_meetings","arguments":{"query":"launch email"}}}\n');
  input.write("not json\n");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const parsed = replies.map((line) => JSON.parse(line));
  assert.equal(parsed.length, 2);
  assert.match(parsed.find((reply) => reply.id === 7).result.content[0].text, /Launch plan for October/);
  assert.equal(parsed.find((reply) => reply.id === null).error.code, -32700);
  await fs.rm(root, { recursive: true, force: true });
});

test("the CLI parses flags and prints tool output", async () => {
  assert.deepEqual(parse(["acme", "pricing", "--limit", "3", "--all", "--from=2026-09-01"]), {
    positional: ["acme", "pricing"],
    flags: { limit: "3", all: true, from: "2026-09-01" },
  });
  const { root, tools } = await fixture();
  const printed = [];
  await run(["actions", "--all"], { tools, out: (text) => printed.push(text) });
  assert.match(printed[0], /questionnaire[\s\S]*launch email|launch email[\s\S]*questionnaire/);
  await run(["--help"], { out: (text) => printed.push(text) });
  assert.match(printed[1], /ember mcp/);
  await assert.rejects(run(["frobnicate"], { tools, out: () => {} }), /Unknown command/);
  await assert.rejects(run(["show"], { tools, out: () => {} }), /Which call/);
  await fs.rm(root, { recursive: true, force: true });
});

test("connecting AI apps writes the CLI and MCP entries, keeping backups and other servers", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "home-"));
  const spec = aiConnect.launchSpec({ execPath: "/Applications/Ember.app/Contents/MacOS/Ember", appPath: "/Applications/Ember.app/Contents/Resources/app.asar" });
  const installed = await aiConnect.installCli(spec, { home, pathEnv: ["/usr/bin", path.join(home, ".local", "bin")].join(path.delimiter) });
  assert.equal(installed.onPath, true);
  const script = await fs.readFile(installed.path, "utf8");
  if (process.platform === "win32") {
    assert.match(script, /set "ELECTRON_RUN_AS_NODE=1"/);
    assert.ok(script.includes(`"${spec.script}" %*`));
  } else {
  assert.match(script, /ELECTRON_RUN_AS_NODE=1 exec '\/Applications\/Ember.app\/Contents\/MacOS\/Ember' '.*app.asar\/src\/cli.js' "\$@"/);
  }
  assert.equal(await aiConnect.cliInstalled(spec, home), true);
  // Someone else's file of the same name is left alone.
  await fs.writeFile(installed.path, "#!/bin/sh\necho mine\n");
  await assert.rejects(aiConnect.installCli(spec, { home }), /wasn't made by Ember/);

  const config = aiConnect.CLIENTS["claude-desktop"].file(home);
  await fs.mkdir(path.dirname(config), { recursive: true });
  await fs.writeFile(config, JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }));
  const status = await aiConnect.connectClient("claude-desktop", spec, home);
  assert.equal(status.connected, true);
  const written = JSON.parse(await fs.readFile(config, "utf8"));
  assert.deepEqual(written.mcpServers.other, { command: "x" });
  assert.equal(written.theme, "dark");
  assert.deepEqual(written.mcpServers.ember.args, [spec.script, "mcp"]);
  assert.equal(JSON.parse(await fs.readFile(`${config}.bak`, "utf8")).mcpServers.ember, undefined);
  assert.equal((await aiConnect.disconnectClient("claude-desktop", spec, home)).connected, false);
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(config, "utf8")).mcpServers), ["other"]);

  await fs.writeFile(config, "{ broken");
  await assert.rejects(aiConnect.connectClient("claude-desktop", spec, home), /isn't valid JSON/);
  assert.match(aiConnect.snippets(spec, { cliOnPath: true }).claudeCode, /^claude mcp add ember -s user -- ember mcp$/);
  await fs.rm(home, { recursive: true, force: true });
});

test("repoints commands and app entries it installed after the app moves, under the old name too", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const aiConnect = require("../src/ai-connect");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "connect-"));
  // An update keeps the bundle where it was installed; only the binary inside is renamed.
  const oldSpec = aiConnect.launchSpec({ execPath: "/Applications/Meeting Notes.app/Contents/MacOS/Meeting Notes", appPath: "/Applications/Meeting Notes.app/Contents/Resources/app.asar" });
  const newSpec = aiConnect.launchSpec({ execPath: "/Applications/Meeting Notes.app/Contents/MacOS/Ember", appPath: "/Applications/Meeting Notes.app/Contents/Resources/app.asar" });
  // What 1.9 installed: a meeting-notes command and a "meeting-notes" Claude Desktop entry, next to someone else's server.
  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
  fs.writeFileSync(aiConnect.cliPath(home, "meeting-notes"), aiConnect.cliScript(oldSpec).replace("Installed by Ember", "Installed by Meeting Notes"));
  fs.writeFileSync(aiConnect.cliPath(home, "ember"), "#!/bin/sh\necho someone else's ember\n");
  const desktop = aiConnect.CLIENTS["claude-desktop"].file(home);
  fs.mkdirSync(path.dirname(desktop), { recursive: true });
  fs.writeFileSync(desktop, JSON.stringify({ mcpServers: { "meeting-notes": aiConnect.serverEntry(oldSpec), other: { command: "/usr/bin/other", args: ["x"] } } }));

  const changed = await aiConnect.refreshConnections(newSpec, home);
  assert.equal(changed.length, 2);
  assert.match(fs.readFileSync(aiConnect.cliPath(home, "meeting-notes"), "utf8"), /MacOS\/Ember/);
  assert.match(fs.readFileSync(aiConnect.cliPath(home, "ember"), "utf8"), /someone else's ember/);
  const config = JSON.parse(fs.readFileSync(desktop, "utf8"));
  assert.deepEqual(config.mcpServers["meeting-notes"], aiConnect.serverEntry(newSpec));
  assert.deepEqual(config.mcpServers.other, { command: "/usr/bin/other", args: ["x"] });
  assert.equal((await aiConnect.clientStatus("claude-desktop", newSpec, home)).connected, true);
  assert.deepEqual(await aiConnect.refreshConnections(newSpec, home), []);
  fs.rmSync(home, { recursive: true, force: true });
});

test("Windows command wrappers preserve paths and percent characters", () => {
  const script = aiConnect.cliScript({ command: "C:\\Program Files\\Ember\\Ember.exe", script: "C:\\100% Files\\app.asar\\src\\cli.js" }, { platform: "win32" });
  assert.ok(script.startsWith("@echo off\r\n"));
  assert.ok(script.includes('"C:\\Program Files\\Ember\\Ember.exe" "C:\\100%% Files\\app.asar\\src\\cli.js" %*'));
  assert.ok(script.includes('set "ELECTRON_RUN_AS_NODE=1"'));
});
