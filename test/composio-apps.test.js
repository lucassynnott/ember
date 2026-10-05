const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { HostedComposio, InstallSecret } = require("../src/composio-apps");
const { ActionSender, Integrations, findUrl, notesAsText } = require("../src/action-destinations");

// A stand-in for Composio's v3 API, as the relay calls it.
function fakeComposio(apiKey = "ak_project") {
  const state = { accounts: [], configs: [], executed: [], nextId: 1 };
  const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input instanceof URL ? input.href : typeof input === "string" ? input : input.url);
    assert.equal(init.headers["x-api-key"], apiKey, "the relay sends its project key");
    const route = url.pathname.replace("/api/v3", "");
    const body = init.body ? JSON.parse(init.body) : null;
    if (route === "/auth_configs" && init.method === "GET") return reply(200, { items: state.configs.filter((config) => config.toolkit === url.searchParams.get("toolkit_slug")) });
    if (route === "/auth_configs" && init.method === "POST") {
      const config = { id: `ac_${state.nextId++}`, name: body.auth_config.name, toolkit: body.toolkit.slug, restrict: body.auth_config.restrict_to_following_tools };
      state.configs.push(config);
      return reply(201, { auth_config: { id: config.id } });
    }
    if (route === "/connected_accounts/link") {
      const config = state.configs.find((item) => item.id === body.auth_config_id);
      const account = { id: `ca_${state.nextId++}`, user_id: body.user_id, toolkit: { slug: config.toolkit }, status: "ACTIVE", created_at: "2026-10-05" };
      state.accounts.push(account);
      return reply(200, { redirect_url: `https://connect.composio.dev/link/${account.id}`, connected_account_id: account.id, link_token: "x", expires_at: "later" });
    }
    if (route === "/connected_accounts" && init.method === "GET") {
      const users = (url.searchParams.get("user_ids") || "").split(",");
      return reply(200, { items: state.accounts.filter((account) => users.includes(account.user_id)) });
    }
    const one = /^\/connected_accounts\/(ca_\d+)$/.exec(route);
    if (one && init.method === "GET") {
      const account = state.accounts.find((item) => item.id === one[1]);
      return account ? reply(200, account) : reply(404, { error: { message: "not found" } });
    }
    if (one && init.method === "DELETE") {
      state.accounts = state.accounts.filter((item) => item.id !== one[1]);
      return reply(200, { success: true });
    }
    const tool = /^\/tools\/execute\/(\w+)$/.exec(route);
    if (tool) {
      state.executed.push({ tool: tool[1], ...body });
      const data = {
        LINEAR_LIST_LINEAR_TEAMS: { teams: [{ id: "team-1", name: "Product", key: "PRD" }] },
        LINEAR_CREATE_LINEAR_ISSUE: { id: "iss-uuid-1", identifier: "PRD-12", url: "https://linear.app/acme/issue/PRD-12" },
        NOTION_FETCH_DATABASE: { properties: { Task: { type: "title" }, Done: { type: "checkbox" } } },
        LINEAR_LIST_LINEAR_STATES: { states: [{ id: "s-todo", type: "unstarted", position: 1 }, { id: "s-done", type: "completed", position: 3 }, { id: "s-backlog", type: "backlog", position: 0 }] },
        LINEAR_UPDATE_ISSUE: { success: true },
        NOTION_UPDATE_ROW_DATABASE: { id: "row-1" },
        GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN: { documentId: "gdoc-9" },
        GOOGLEDRIVE_GET_FILE_METADATA: { id: "gdoc-9", parents: ["root-id"], webViewLink: "https://docs.google.com/document/d/gdoc-9/edit" },
        GOOGLEDRIVE_MOVE_FILE: { id: "gdoc-9" },
        NOTION_INSERT_ROW_DATABASE: { id: "row-1", url: "https://www.notion.so/row1" },
        GOOGLEDRIVE_CREATE_FILE_FROM_TEXT: { id: "doc-1", webViewLink: "https://docs.google.com/document/d/doc-1/edit" },
      }[tool[1]];
      return reply(200, { successful: true, data, error: null });
    }
    return reply(404, { error: { message: `no route ${route}` } });
  };
  return { state, fetchImpl, apiKey };
}

async function relayClient(worker, composio, secret) {
  const env = { COMPOSIO_API_KEY: composio.apiKey };
  // The app's fetch goes to the Worker; the Worker's fetch goes to the fake Composio.
  const appFetch = async (url, init) => {
    const saved = globalThis.fetch;
    globalThis.fetch = composio.fetchImpl;
    try {
      return await worker.default.fetch(new Request(url, init), env);
    } finally {
      globalThis.fetch = saved;
    }
  };
  return new HostedComposio({ baseUrl: "https://relay.test", secret: { get: async () => secret }, openExternal: async () => {}, fetchImpl: appFetch, pollMs: 1 });
}

test("the relay keeps installs apart, only runs allowed tools, and restricts sign-in configs", async () => {
  const worker = await import("../server/composio-relay/worker.mjs");
  const composio = fakeComposio();
  const alice = await relayClient(worker, composio, "a".repeat(64));
  const bob = await relayClient(worker, composio, "b".repeat(64));

  const linear = await alice.connect("linear");
  assert.match(linear.id, /^ca_/);
  assert.deepEqual(composio.state.configs[0].restrict, ["LINEAR_LIST_LINEAR_TEAMS", "LINEAR_CREATE_LINEAR_ISSUE", "LINEAR_LIST_LINEAR_STATES", "LINEAR_UPDATE_ISSUE"]);
  await alice.connect("linear");
  assert.equal(composio.state.configs.length, 1, "the sign-in config is reused");

  assert.equal((await alice.connections()).length, 2);
  assert.equal((await bob.connections()).length, 0, "Bob can't see Alice's connections");
  await assert.rejects(bob.execute("LINEAR_CREATE_LINEAR_ISSUE", { team_id: "t", title: "x" }, linear.id), /Connect linear first/);
  await assert.rejects(bob.disconnect(linear.id), /No such connection/);
  await assert.rejects(alice.execute("LINEAR_DELETE_ISSUE", {}, linear.id), /isn't allowed/);
  await assert.rejects(alice.execute("NOTION_INSERT_ROW_DATABASE", {}, linear.id), /Connect notion first/, "a Linear connection can't run Notion tools");

  const ok = await alice.execute("LINEAR_LIST_LINEAR_TEAMS", { first: 5 }, linear.id);
  assert.equal(ok.successful, true);
  const userIds = new Set(composio.state.executed.map((call) => call.user_id));
  assert.equal(userIds.size, 1);
  assert.match([...userIds][0], /^mn_[0-9a-f]{40}$/);

  const response = await worker.default.fetch(new Request("https://relay.test/v1/connections", { headers: { authorization: "Bearer nope" } }), { COMPOSIO_API_KEY: "ak_project" });
  assert.equal(response.status, 401);
});

test("action items go to Linear, Notion and Reminders once each, and notes become a Google Doc", async () => {
  const worker = await import("../server/composio-relay/worker.mjs");
  const composio = fakeComposio("ak_second_project");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "actions-out-"));
  const reminders = [];
  const meeting = {
    id: "2026-10-05-1100",
    title: "Acme renewal call",
    startedAt: Date.UTC(2026, 9, 5, 11),
    actionItems: [
      { owner: "Alex Rivera", task: "Send the security questionnaire", done: false },
      { owner: "Priya Shah", task: "Confirm the billing contact", done: false },
    ],
  };
  const sender = new ActionSender({
    integrations: new Integrations(path.join(dir, "integrations.json")),
    hosted: await relayClient(worker, composio, "c".repeat(64)),
    personal: null,
    calendar: {
      completeReminder: async () => true,
      remindersStatus: async () => "granted",
      reminderLists: async () => ({ lists: [{ id: "inbox", title: "Inbox" }] }),
      addReminder: async (reminder) => reminders.push(reminder),
    },
    library: { get: async () => meeting },
    speakerName: () => "Alex Rivera",
  });

  await assert.rejects(sender.send(meeting.id, 0, "linear"), /Connect Linear/);
  await sender.connect("linear");
  await sender.connect("notion");
  await sender.connect("googledrive");
  assert.equal((await sender.state()).connected.googledocs, true, "Google Docs comes with Drive");
  const [team] = await sender.options("linear");
  assert.deepEqual(team, { id: "team-1", name: "Product (PRD)" });
  await sender.choose("linear", team);
  await sender.choose("notion", { id: "db-1", name: "Tasks" });
  assert.equal((await sender.integrations.load()).notionDatabase.titleProperty, "Task");
  assert.equal((await sender.integrations.load()).notionDatabase.doneProperty, "Done");

  const issue = await sender.send(meeting.id, 0, "linear");
  assert.equal(issue.url, "https://linear.app/acme/issue/PRD-12");
  const create = composio.state.executed.find((call) => call.tool === "LINEAR_CREATE_LINEAR_ISSUE");
  assert.equal(create.arguments.team_id, "team-1");
  assert.match(create.arguments.description, /Acme renewal call/);
  await sender.send(meeting.id, 0, "linear");
  assert.equal(composio.state.executed.filter((call) => call.tool === "LINEAR_CREATE_LINEAR_ISSUE").length, 1, "not sent twice");

  const row = await sender.send(meeting.id, 1, "notion");
  assert.equal(row.url, "https://www.notion.so/row1");
  assert.deepEqual(composio.state.executed.find((call) => call.tool === "NOTION_INSERT_ROW_DATABASE").arguments.properties, [
    { name: "Task", type: "title", value: "Confirm the billing contact" },
  ]);

  await sender.choose("reminders", { id: "inbox", name: "Inbox" });
  await sender.setAutoSend({ autoSend: "all", autoSendTo: "reminders" });
  assert.equal((await sender.autoSend(meeting.id)).length, 0, "both items were already sent by hand");
  meeting.actionItems.push({ owner: "Alex Rivera", task: "Book the follow-up", done: false }, { owner: "Priya Shah", task: "Share the deck", done: false });
  await sender.setAutoSend({ autoSend: "mine", autoSendTo: "reminders" });
  const sent = await sender.autoSend(meeting.id);
  assert.equal(sent.length, 1, "only Alex's own new item");
  assert.equal(reminders[0].title, "Book the follow-up");

  // Ticking an item off updates it where it was sent.
  assert.equal(await sender.syncDone(meeting.id, 0, true), true);
  const update = composio.state.executed.find((call) => call.tool === "LINEAR_UPDATE_ISSUE").arguments;
  assert.deepEqual(update, { issueId: "iss-uuid-1", stateId: "s-done" });
  await sender.syncDone(meeting.id, 0, false);
  assert.equal(composio.state.executed.filter((call) => call.tool === "LINEAR_UPDATE_ISSUE").at(-1).arguments.stateId, "s-todo");
  await sender.syncDone(meeting.id, 1, true);
  assert.deepEqual(composio.state.executed.find((call) => call.tool === "NOTION_UPDATE_ROW_DATABASE").arguments, {
    row_id: "row-1",
    properties: [{ name: "Done", type: "checkbox", value: "True" }],
  });

  // Notes: a formatted Google Doc, moved from My Drive into the chosen folder.
  await sender.choose("googledrive", { id: "folder-1", name: "Meeting notes" });
  const doc = await sender.saveNotesToDrive(meeting.id, "# Acme renewal call\n\n- **Audio:** [a.webm](./a.webm)\n\n## Action items\n\n- [ ] **Alex Rivera** — Send it\n\n![Slide 1](./x-shared/slide-001.jpg)", "Acme renewal call");
  assert.equal(doc.url, "https://docs.google.com/document/d/gdoc-9/edit");
  const created = composio.state.executed.find((call) => call.tool === "GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN").arguments;
  assert.doesNotMatch(created.markdown_text, /webm|slide-001/, "no local audio or image links");
  assert.match(created.markdown_text, /## Action items/);
  assert.deepEqual(composio.state.executed.find((call) => call.tool === "GOOGLEDRIVE_MOVE_FILE").arguments, { file_id: "gdoc-9", add_parents: "folder-1", remove_parents: "root-id" });
  await fs.rm(dir, { recursive: true, force: true });
});

test("helpers: URLs are found anywhere in an answer, and notes read cleanly as text", () => {
  assert.equal(findUrl({ data: { issue: { url: "https://linear.app/x/PRD-1" } } }, "linear.app"), "https://linear.app/x/PRD-1");
  assert.equal(findUrl({ url: "https://elsewhere" }, "linear.app"), null);
  assert.equal(notesAsText("## Summary\n\n- **Bold** point\n![Slide](./a.jpg)\n- [x] done"), "Summary\n\n• Bold point\n\n☑ done");
});

test("the install secret is created once and kept encrypted", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "secret-"));
  const file = path.join(dir, "relay.json");
  const crypt = { encrypt: (value) => `enc:${value}`, decrypt: (value) => value.slice(4) };
  const first = await new InstallSecret({ filePath: file, ...crypt }).get();
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(await new InstallSecret({ filePath: file, ...crypt }).get(), first);
  assert.match(await fs.readFile(file, "utf8"), /enc:/);
  await fs.rm(dir, { recursive: true, force: true });
});

test("a Notion database's done column is found: a Done checkbox, or a Status with a completed option", () => {
  const { notionDoneProperty } = require("../src/action-destinations");
  assert.deepEqual(notionDoneProperty({ Name: { type: "title" }, Done: { type: "checkbox" }, Urgent: { type: "checkbox" } }), { doneProperty: "Done", doneType: "checkbox" });
  assert.deepEqual(
    notionDoneProperty({
      Status: {
        type: "status",
        status: {
          options: [{ id: "1", name: "Not started" }, { id: "2", name: "In progress" }, { id: "3", name: "Shipped" }],
          groups: [{ name: "To-do", option_ids: ["1"] }, { name: "In progress", option_ids: ["2"] }, { name: "Complete", option_ids: ["3"] }],
        },
      },
    }),
    { doneProperty: "Status", doneType: "status", doneValue: "Shipped", openValue: "Not started" },
  );
  assert.deepEqual(notionDoneProperty({ Name: { type: "title" } }), {});
});
