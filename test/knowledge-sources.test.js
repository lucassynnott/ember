const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { formatMeetingNote } = require("../src/note");
const { HttpTransport, McpClient, parseEventStream, pickSearchTool, splitCommand } = require("../src/mcp-client");
const { KnowledgeSources, parseEnv } = require("../src/knowledge-sources");

const fakeCrypto = { encrypt: (value) => `enc:${Buffer.from(value).toString("base64")}`, decrypt: (value) => Buffer.from(value.slice(4), "base64").toString() };

test("commands split like a shell, env lines parse, and bad lines are caught", () => {
  assert.deepEqual(splitCommand(`npx -y "@acme/docs mcp" --root '/Users/alex/My Docs'`), ["npx", "-y", "@acme/docs mcp", "--root", "/Users/alex/My Docs"]);
  assert.throws(() => splitCommand(`npx "open`), /isn't closed/);
  assert.deepEqual(parseEnv(`API_KEY = "abc123"\n\nREGION=eu`), { API_KEY: "abc123", REGION: "eu" });
  assert.throws(() => parseEnv("not a pair"), /NAME=value/);
});

test("the search tool and its question argument are found", () => {
  const tools = [
    { name: "create_page", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
    { name: "get_page", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    { name: "search_docs", description: "Search the docs", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] } },
  ];
  assert.deepEqual(pickSearchTool(tools), { tool: "search_docs", queryArg: "query" });
  assert.equal(pickSearchTool([tools[0]]), null);
});

test("Streamable HTTP: session header, event-stream replies and bearer tokens", async () => {
  assert.deepEqual(parseEventStream('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n: ping\n\n'), [{ jsonrpc: "2.0", id: 1, result: {} }]);
  assert.throws(() => new HttpTransport({ url: "http://example.com/mcp" }), /https/);
  const calls = [];
  const fetchImpl = async (url, init) => {
    const message = JSON.parse(init.body || "{}");
    calls.push({ headers: init.headers, method: message.method });
    const headers = new Headers({ "content-type": message.method === "initialize" ? "application/json" : "text/event-stream", "mcp-session-id": "s-1" });
    if (message.id === undefined) return new Response(null, { status: 202, headers });
    const result =
      message.method === "initialize"
        ? { protocolVersion: "2025-06-18", serverInfo: { name: "docs" }, capabilities: {} }
        : message.method === "tools/list"
          ? { tools: [{ name: "search", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }] }
          : { content: [{ type: "text", text: `Found: ${message.params.arguments.q}` }] };
    const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
    return new Response(message.method === "initialize" ? body : `data: ${body}\n\n`, { status: 200, headers });
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sources-"));
  const sources = new KnowledgeSources({ filePath: path.join(dir, "sources.json"), ...fakeCrypto, open: (source, options) => McpClient.open(source, { ...options, fetchImpl }) });
  const [added] = await sources.add({ name: "", kind: "url", url: "https://docs.example.com/mcp", token: "tok-123" });
  assert.equal(added.name, "docs");
  assert.equal(added.tool, "search");
  assert.equal(added.queryArg, "q");
  assert.equal(added.hasToken, true);
  // The token is stored encrypted, never in the clear.
  assert.doesNotMatch(await fs.readFile(path.join(dir, "sources.json"), "utf8"), /tok-123/);

  const passages = await sources.search("pricing objections");
  assert.deepEqual(passages, [{ file: `mcp:${added.id}`, name: "docs", text: "Found: pricing objections" }]);
  const later = calls.filter((call) => call.method === "tools/call").pop();
  assert.equal(later.headers.authorization, "Bearer tok-123");
  assert.equal(later.headers["mcp-session-id"], "s-1");
  sources.closeAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("a local command over stdio: the app's own MCP server as a source", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stdio-"));
  const notes = path.join(root, "notes");
  await fs.mkdir(notes);
  const startedAt = new Date(2026, 8, 29, 16, 5);
  await fs.writeFile(
    path.join(notes, "2026-09-29-1605.md"),
    formatMeetingNote({
      startedAt,
      endedAt: new Date(startedAt.getTime() + 1800000),
      transcript: "Priya Shah: Quarterly billing is approved.",
      audioFileName: "2026-09-29-1605.webm",
      analysis: { title: "Acme renewal call", summary: ["Acme wants quarterly billing."], decisions: [], actionItems: [], transcriptionProvider: "Phonon-2", summaryProvider: "OpenRouter" },
    }),
  );
  await fs.writeFile(path.join(root, "settings.json"), JSON.stringify({ notesDir: notes }));
  const sources = new KnowledgeSources({ filePath: path.join(root, "sources.json"), ...fakeCrypto });
  const command = `"${process.execPath}" "${path.join(__dirname, "..", "src", "cli.js")}" mcp`;
  const [added] = await sources.add({ name: "Old calls", kind: "command", command, env: `MEETING_NOTES_DATA=${root}` });
  assert.equal(added.tool, "search_meetings");
  assert.deepEqual(added.envKeys, ["MEETING_NOTES_DATA"]);
  const [passage] = await sources.search("quarterly billing");
  assert.equal(passage.name, "Old calls");
  assert.match(passage.text, /Acme renewal call/);

  // A disabled source isn't asked; a broken one is skipped with its error kept.
  await sources.update(added.id, { enabled: false });
  assert.deepEqual(await sources.search("quarterly billing"), []);
  await sources.update(added.id, { enabled: true });
  sources.closeAll();
  await assert.rejects(sources.add({ kind: "command", command: "definitely-not-a-command-xyz" }), /Couldn't find/);
  await sources.remove(added.id);
  assert.deepEqual(await sources.list(), []);
  await fs.rm(root, { recursive: true, force: true });
});
