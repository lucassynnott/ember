const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { discover, resourceMetadataFrom, signIn } = require("../src/mcp-oauth");
const { KnowledgeSources } = require("../src/knowledge-sources");

const fakeCrypto = { encrypt: (value) => `enc:${Buffer.from(value).toString("base64")}`, decrypt: (value) => Buffer.from(value.slice(4), "base64").toString() };

// An MCP server behind OAuth, following the MCP authorization spec.
async function oauthServer() {
  const state = { valid: new Set(), refresh: new Map(), challenges: new Map(), registered: [], issued: 0, calls: [] };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    let body = "";
    for await (const chunk of request) body += chunk;
    const base = `http://127.0.0.1:${server.address().port}`;
    const json = (status, data, headers = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(data));
    };
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return json(200, { resource: `${base}/mcp`, authorization_servers: [`${base}/auth`], scopes_supported: ["read"] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server/auth") {
      return json(200, {
        issuer: `${base}/auth`,
        authorization_endpoint: `${base}/auth/authorize`,
        token_endpoint: `${base}/auth/token`,
        registration_endpoint: `${base}/auth/register`,
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/auth/register") {
      const client = JSON.parse(body);
      state.registered.push(client);
      return json(201, { client_id: `client-${state.registered.length}` });
    }
    if (url.pathname === "/auth/authorize") {
      // The user approves straight away.
      const code = `code-${crypto.randomUUID()}`;
      state.challenges.set(code, { challenge: url.searchParams.get("code_challenge"), resource: url.searchParams.get("resource"), scope: url.searchParams.get("scope") });
      const back = new URL(url.searchParams.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state"));
      response.writeHead(302, { location: back.href });
      return response.end();
    }
    if (url.pathname === "/auth/token") {
      const form = new URLSearchParams(body);
      const issue = () => {
        state.issued += 1;
        const access = `access-${state.issued}`;
        const refresh = `refresh-${state.issued}`;
        state.valid.add(access);
        state.refresh.set(refresh, true);
        return json(200, { access_token: access, refresh_token: refresh, expires_in: 3600, token_type: "Bearer" });
      };
      if (form.get("grant_type") === "authorization_code") {
        const pending = state.challenges.get(form.get("code"));
        const challenge = crypto.createHash("sha256").update(form.get("code_verifier") || "").digest("base64url");
        if (!pending || pending.challenge !== challenge || pending.resource !== `${base}/mcp`) return json(400, { error: "invalid_grant" });
        state.challenges.delete(form.get("code"));
        return issue();
      }
      if (form.get("grant_type") === "refresh_token" && state.refresh.get(form.get("refresh_token"))) {
        state.refresh.delete(form.get("refresh_token"));
        return issue();
      }
      return json(400, { error: "invalid_grant" });
    }
    if (url.pathname === "/mcp") {
      const token = /^Bearer (.+)$/.exec(request.headers.authorization || "")?.[1];
      if (!state.valid.has(token)) {
        return json(401, { error: "invalid_token" }, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
      }
      const message = JSON.parse(body);
      state.calls.push({ method: message.method, token });
      if (message.id === undefined) {
        response.writeHead(202);
        return response.end();
      }
      const result =
        message.method === "initialize"
          ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "wiki" } }
          : message.method === "tools/list"
            ? { tools: [{ name: "search", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }] }
            : { content: [{ type: "text", text: `Found: ${message.params.arguments.query}` }] };
      return json(200, { jsonrpc: "2.0", id: message.id, result });
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, state, url: `http://127.0.0.1:${server.address().port}/mcp` };
}

// Stands in for the browser: follows the sign-in redirect back to the app.
const browser = async (link) => {
  const response = await fetch(link, { redirect: "manual" });
  await fetch(response.headers.get("location"));
};

test("discovery reads the protected resource and authorization server metadata", async () => {
  const { server, url } = await oauthServer();
  const found = await discover(url);
  assert.equal(found.resource, url);
  assert.match(found.authorizationEndpoint, /\/auth\/authorize$/);
  assert.match(found.registrationEndpoint, /\/auth\/register$/);
  assert.deepEqual(found.scopes, ["read"]);
  assert.equal(resourceMetadataFrom('Bearer error="invalid_token", resource_metadata="https://x/.well-known/y"'), "https://x/.well-known/y");
  await assert.rejects(discover("http://example.com/mcp"), /secure/);
  server.closeAllConnections();
  server.close();
});

test("sign-in registers the app, uses PKCE and returns tokens", async () => {
  const { server, state, url } = await oauthServer();
  const session = await signIn(url, { openBrowser: browser });
  assert.equal(session.clientId, "client-1");
  assert.equal(session.accessToken, "access-1");
  assert.equal(session.refreshToken, "refresh-1");
  assert.ok(session.expiresAt > Date.now());
  assert.match(state.registered[0].redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(state.registered[0].token_endpoint_auth_method, "none");
  server.closeAllConnections();
  server.close();
});

test("a connected source signs in when asked, refreshes expired tokens, and asks to sign in again when revoked", async () => {
  const { server, state, url } = await oauthServer();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oauth-sources-"));
  let signIns = 0;
  const sources = new KnowledgeSources({
    filePath: path.join(dir, "sources.json"),
    ...fakeCrypto,
    signIn: async (serverUrl, options) => {
      signIns += 1;
      return signIn(serverUrl, { ...options, openBrowser: browser });
    },
  });
  const [added] = await sources.add({ name: "", kind: "url", url });
  assert.equal(signIns, 1);
  assert.equal(added.name, "wiki");
  assert.equal(added.signedIn, true);
  assert.doesNotMatch(await fs.readFile(path.join(dir, "sources.json"), "utf8"), /access-1|refresh-1/, "tokens are stored encrypted");

  assert.equal((await sources.search("pricing"))[0].text, "Found: pricing");

  // The server forgets the access token: one refresh, then the call goes through.
  state.valid.clear();
  sources.closeAll();
  assert.equal((await sources.search("renewal"))[0].text, "Found: renewal");
  assert.equal(state.calls.at(-1).token, "access-2");

  // Everything revoked: the source says to sign in again, then works after it.
  state.valid.clear();
  state.refresh.clear();
  sources.closeAll();
  assert.deepEqual(await sources.search("again"), []);
  assert.equal((await sources.list())[0].needsSignIn, true);
  await sources.signInAgain(added.id);
  assert.equal(signIns, 2);
  assert.equal((await sources.list())[0].needsSignIn, false);
  assert.equal((await sources.search("back"))[0].text, "Found: back");
  sources.closeAll();
  server.closeAllConnections();
  server.close();
  await fs.rm(dir, { recursive: true, force: true });
});
