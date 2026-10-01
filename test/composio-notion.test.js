const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { ComposioNotion, parseComposioLogin } = require("../src/composio-notion");
const { NotionConnect, friendly } = require("../src/notion-connect");

const LOGIN_OUTPUT = `Open this URL in your browser to log in:

  https://dashboard.composio.dev/?cliKey=b6129b42-34c9-412e-be6c-87ddca8bb9ab

Then run this command to complete login:

  composio login --poll
`;

test("reads the sign-in link from real composio login output", () => {
  assert.equal(parseComposioLogin(LOGIN_OUTPUT), "https://dashboard.composio.dev/?cliKey=b6129b42-34c9-412e-be6c-87ddca8bb9ab");
  assert.equal(parseComposioLogin("error: offline"), null);
});

// A stand-in composio: signed out until `login --poll`, no Notion link until the link step runs,
// and a proxy that echoes the request it was given.
function fakeRelease(directory) {
  const build = path.join(directory, "build", "composio-darwin-aarch64");
  fs.mkdirSync(build, { recursive: true });
  const state = path.join(directory, "state");
  fs.mkdirSync(state);
  fs.writeFileSync(
    path.join(build, "composio"),
    `#!/bin/sh
S="${state}"
case "$1 $2" in
  "whoami "*) [ -f "$S/in" ] && echo '{"email":"me@example.com"}'; exit 0 ;;
  "login --no-wait") printf '%b' "${LOGIN_OUTPUT.replace(/\n/g, "\\n")}"; exit 0 ;;
  "login --poll") touch "$S/in"; exit 0 ;;
  "link notion")
    [ -f "$S/in" ] || exit 0
    if [ "$3" = "--list" ]; then
      if [ -f "$S/linked" ]; then echo '{"items":[{"id":"ca_new","word_id":"notion_new","status":"ACTIVE"}]}'; else echo '{"items":[]}'; fi
    else
      touch "$S/linked"
      echo '{"status":"pending","connected_account_id":"ca_new","redirect_url":"https://connect.composio.dev/link/lk_test"}'
    fi
    exit 0 ;;
  "proxy https://api.notion.com/v1/users/me") echo '{"object":"user","bot":{"workspace_name":"Test Workspace","owner":{"user":{"name":"Test User"}}}}'; exit 0 ;;
  "proxy https://api.notion.com/v1/missing") echo '{"object":"error","status":404,"code":"object_not_found","message":"Could not find page"}'; exit 0 ;;
  "proxy "*) echo "{\\"object\\":\\"page\\",\\"args\\":\\"$*\\",\\"body\\":$(cat)}"; exit 0 ;;
esac
exit 2
`,
    { mode: 0o755 },
  );
  const archive = path.join(directory, "composio.zip");
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", build, archive]);
  const bytes = fs.readFileSync(archive);
  return {
    bytes,
    state,
    release: { version: "test", url: "https://github.com/test.zip", sha256: crypto.createHash("sha256").update(bytes).digest("hex"), size: bytes.length },
  };
}

function fetchFor(bytes) {
  return async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (let offset = 0; offset < bytes.length; offset += 512) controller.enqueue(bytes.subarray(offset, offset + 512));
          controller.close();
        },
      }),
      { status: 200 },
    );
}

test("installs Composio with progress, signs in, links Notion and saves through the proxy", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "composio-notion-"));
  const { bytes, release } = fakeRelease(directory);
  const supportDir = path.join(directory, "support");
  const installed = path.join(supportDir, "composio", "composio");
  const opened = [];
  const composio = new ComposioNotion({
    openExternal: async (url) => opened.push(url),
    supportDir,
    fetchImpl: fetchFor(bytes),
    release,
    findBinary: async () => (fs.existsSync(installed) ? installed : null),
    pollMs: 10,
  });
  const auth = { method: "composio", composioAccount: "" };
  const connect = new NotionConnect({ openExternal: async () => {}, supportDir, composio, getAuth: () => auth });
  const events = [];
  connect.on("progress", (progress) => events.push(progress));

  const account = await connect.connect("composio");
  assert.deepEqual(account, { name: "Test User", email: "", workspace: "Test Workspace", accountId: "notion_new" });
  assert.deepEqual(opened, ["https://dashboard.composio.dev/?cliKey=b6129b42-34c9-412e-be6c-87ddca8bb9ab", "https://connect.composio.dev/link/lk_test"]);
  assert.ok(events.some((event) => event.state === "downloading" && event.total === release.size));
  assert.ok(events.some((event) => event.state === "installing"));
  assert.deepEqual(
    events.filter((event) => event.state === "waiting").map((event) => event.step),
    ["composio", "notion"],
  );
  assert.equal(events.at(-1).state, "connected");

  auth.composioAccount = account.accountId;
  const status = await connect.status("", "");
  assert.equal(status.method, "composio");
  assert.equal(status.account.name, "Test User");

  const page = await connect.request("POST", "v1/pages", { hello: "world" });
  assert.deepEqual(page.body, { hello: "world" });
  assert.match(page.args, /--toolkit notion -X POST -H Notion-Version: 2026-03-11 --account notion_new/);

  await assert.rejects(connect.request("GET", "v1/missing"), (error) => {
    assert.match(friendly(error, "composio").message, /Share it with Composio in Notion/);
    return true;
  });
});

test("refuses a Composio download whose checksum doesn't match", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "composio-notion-"));
  const { bytes, release } = fakeRelease(directory);
  const composio = new ComposioNotion({
    openExternal: async () => {},
    supportDir: path.join(directory, "support"),
    fetchImpl: fetchFor(bytes),
    release: { ...release, sha256: "0".repeat(64) },
    findBinary: async () => null,
  });
  const connect = new NotionConnect({ openExternal: async () => {}, composio });
  await assert.rejects(connect.connect("composio"));
  assert.equal(fs.existsSync(path.join(directory, "support", "composio", "composio")), false);
});
