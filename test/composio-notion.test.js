const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ZipFile } = require("yazl");
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
async function fakeRelease(directory) {
  const build = path.join(directory, "build", "composio-darwin-aarch64");
  fs.mkdirSync(build, { recursive: true });
  const state = path.join(directory, "state");
  fs.mkdirSync(state);
  const executable = "composio.cjs";
  const script = `
const fs = require("node:fs");
const S = ${JSON.stringify(state)};
const args = process.argv.slice(2);
const has = name => fs.existsSync(require("node:path").join(S, name));
const touch = name => fs.writeFileSync(require("node:path").join(S, name), "");
const output = value => console.log(JSON.stringify(value));
if (args[0] === "whoami") { if (has("in")) output({email:"me@example.com"}); }
else if (args[0] === "login" && args[1] === "--no-wait") console.log(${JSON.stringify(LOGIN_OUTPUT)});
else if (args[0] === "login" && args[1] === "--poll") touch("in");
else if (args[0] === "link" && args[1] === "notion") {
  if (has("in")) {
    if (args[2] === "--list") output({items: has("linked") ? [{id:"ca_new",word_id:"notion_new",status:"ACTIVE"}] : []});
    else { touch("linked"); output({status:"pending",connected_account_id:"ca_new",redirect_url:"https://connect.composio.dev/link/lk_test"}); }
  }
} else if (args[0] === "proxy" && args[1].endsWith("/users/me")) {
  output({object:"user",bot:{workspace_name:"Test Workspace",owner:{user:{name:"Test User"}}}});
} else if (args[0] === "proxy" && args[1].endsWith("/missing")) {
  output({object:"error",status:404,code:"object_not_found",message:"Could not find page"});
} else if (args[0] === "proxy") {
  let body = "";
  process.stdin.on("data", chunk => body += chunk);
  process.stdin.on("end", () => output({object:"page",args:args.join(" "),body:JSON.parse(body)}));
} else process.exit(2);
`;
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(script), "composio-darwin-aarch64/" + executable, { mode: 0o100755 });
  const chunks = [];
  const bytesPromise = new Promise((resolve, reject) => {
    zip.outputStream.on("data", chunk => chunks.push(chunk));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
  zip.end();
  const bytes = await bytesPromise;
  return {
    bytes,
    state,
    release: { executable, version: "test", url: "https://github.com/test.zip", sha256: crypto.createHash("sha256").update(bytes).digest("hex"), size: bytes.length },
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
  const { bytes, release } = await fakeRelease(directory);
  const supportDir = path.join(directory, "support");
  const installed = path.join(supportDir, "composio", "composio.cjs");
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
  const { bytes, release } = await fakeRelease(directory);
  const composio = new ComposioNotion({
    openExternal: async () => {},
    supportDir: path.join(directory, "support"),
    fetchImpl: fetchFor(bytes),
    release: { ...release, sha256: "0".repeat(64) },
    findBinary: async () => null,
  });
  const connect = new NotionConnect({ openExternal: async () => {}, composio });
  await assert.rejects(connect.connect("composio"));
  assert.equal(fs.existsSync(path.join(directory, "support", "composio", "composio.cjs")), false);
});
