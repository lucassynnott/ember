const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { NotionConnect, parseLoginPrompt, parseWhoami } = require("../src/notion-connect");

const LOGIN_OUTPUT = `Open this URL in your browser to log in:

  https://app.notion.com/workers/cli-login?verificationCode=DP9-QL5

Confirm that this verification code matches what you see in the browser:

  DP9-QL5

Then run this command to complete login:

  ntn login poll
`;

test("reads the login link, verification code and account from real ntn output", () => {
  assert.deepEqual(parseLoginPrompt(LOGIN_OUTPUT), {
    url: "https://app.notion.com/workers/cli-login?verificationCode=DP9-QL5",
    code: "DP9-QL5",
  });
  assert.equal(parseLoginPrompt("error: offline"), null);
  assert.deepEqual(
    parseWhoami("3eb7\tNotion CLI\tbot\tlucas@example.com\t0467\tApplied Leverage\t319d\tLucas N\tperson\n"),
    { email: "lucas@example.com", workspace: "Applied Leverage", name: "Lucas N" },
  );
});

// A stand-in ntn: whoami fails until `login poll` has run; poll can be made slow to test cancel.
function fakeRelease(directory, { pollSeconds = 0 } = {}) {
  const build = path.join(directory, "build", "ntn-aarch64-apple-darwin");
  fs.mkdirSync(build, { recursive: true });
  const state = path.join(directory, "logged-in");
  fs.writeFileSync(
    path.join(build, "ntn"),
    `#!/bin/sh
case "$1 $2" in
  "whoami "*) [ -f "${state}" ] && printf 'b\\tNotion CLI\\tbot\\tme@example.com\\tw\\tTest Workspace\\tu\\tTest User\\tperson\\n' && exit 0; echo "error: No workspace selected." >&2; exit 1 ;;
  "login poll") sleep ${pollSeconds}; touch "${state}"; exit 0 ;;
  "login "*) printf '%b' "${LOGIN_OUTPUT.replace(/\n/g, "\\n")}"; exit 0 ;;
esac
exit 2
`,
    { mode: 0o755 },
  );
  const archive = path.join(directory, "ntn.tar.gz");
  execFileSync("/usr/bin/tar", ["-czf", archive, "-C", path.join(directory, "build"), "ntn-aarch64-apple-darwin"]);
  const bytes = fs.readFileSync(archive);
  return {
    bytes,
    release: { version: "test", url: "https://ntn.dev/test.tar.gz", sha256: crypto.createHash("sha256").update(bytes).digest("hex"), size: bytes.length },
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

test("downloads the CLI with progress, signs in through the browser and reports the account", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "notion-connect-"));
  const { bytes, release } = fakeRelease(directory);
  const opened = [];
  const installed = path.join(directory, "support", "bin", "ntn");
  const connect = new NotionConnect({
    openExternal: async (url) => opened.push(url),
    supportDir: path.join(directory, "support"),
    fetchImpl: fetchFor(bytes),
    release,
    findBinary: async () => (fs.existsSync(installed) ? installed : null),
  });
  const states = [];
  connect.on("progress", (progress) => states.push(progress));

  const account = await connect.connect();

  assert.deepEqual(account, { email: "me@example.com", workspace: "Test Workspace", name: "Test User" });
  assert.ok(fs.statSync(installed).mode & 0o100, "installed binary is executable");
  assert.deepEqual(opened, ["https://app.notion.com/workers/cli-login?verificationCode=DP9-QL5"]);
  const downloads = states.filter((state) => state.state === "downloading");
  assert.ok(downloads.length >= 1 && downloads.at(-1).fraction === 1, "progress reaches 100%");
  assert.ok(states.some((state) => state.state === "waiting" && state.code === "DP9-QL5"));
  assert.equal(states.at(-1).state, "connected");
  assert.equal(fs.existsSync(path.join(directory, "support", "bin", "ntn.tar.gz")), false, "archive cleaned up");

  const status = await connect.status("ds-1", "Call Transcripts");
  assert.equal(status.account.name, "Test User");
  assert.deepEqual(status.database, { id: "ds-1", name: "Call Transcripts", url: null });
});

test("refuses a download that fails its checksum", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "notion-connect-"));
  const { bytes, release } = fakeRelease(directory);
  const connect = new NotionConnect({
    openExternal: async () => {},
    supportDir: path.join(directory, "support"),
    fetchImpl: fetchFor(bytes),
    release: { ...release, sha256: "0".repeat(64) },
    findBinary: async () => null,
  });
  await assert.rejects(connect.connect(), /checksum/);
  assert.equal(fs.existsSync(path.join(directory, "support", "bin", "ntn")), false);
});

test("cancelling while waiting for the browser stops the sign-in", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "notion-connect-"));
  const { bytes, release } = fakeRelease(directory, { pollSeconds: 30 });
  const installed = path.join(directory, "support", "bin", "ntn");
  const connect = new NotionConnect({
    openExternal: async () => {},
    supportDir: path.join(directory, "support"),
    fetchImpl: fetchFor(bytes),
    release,
    findBinary: async () => (fs.existsSync(installed) ? installed : null),
  });
  const waiting = new Promise((resolve) => connect.on("progress", (progress) => progress.state === "waiting" && resolve()));
  const result = connect.connect();
  await waiting;
  connect.cancel();
  assert.equal(await result, null);
  assert.equal(connect.progress.state, "cancelled");
});

test("treats a Notion outage as unavailable, never as signed out", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "notion-connect-"));
  const binary = path.join(directory, "ntn");
  fs.writeFileSync(binary, '#!/bin/sh\necho "error: Failed to fetch /v1/users/me: 504 Gateway Timeout" >&2\nexit 1\n', { mode: 0o755 });
  const opened = [];
  const connect = new NotionConnect({ openExternal: async (url) => opened.push(url), findBinary: async () => binary });
  await assert.rejects(connect.connect(), /isn't responding/);
  assert.deepEqual(opened, [], "no browser sign-in during an outage");
  const status = await connect.status("ds-1", "");
  assert.equal(status.unavailable, true);
  assert.equal(status.account, null);
});

test("turns Notion server errors into plain guidance", () => {
  const { friendly } = require("../src/notion-connect");
  const down = friendly(new Error("Notion CLI exited with code 5: error: Public API request failed (500 Internal Server Error internal_server_error): Cross-cell memcached access is not allowed"));
  assert.equal(down.message, "Notion isn't responding right now. Try again in a few minutes.");
  assert.equal(down.unavailable, true);
  assert.match(friendly(new Error("error: Failed to fetch /v1/users/me: 504 Gateway Timeout <!DOCTYPE html>")).message, /isn't responding/);
  assert.match(friendly(new Error("Notion: object_not_found")).message, /couldn't find that page/);
});
