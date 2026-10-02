// Sign-in for MCP servers that use OAuth (the MCP authorization spec): find the server's
// authorization server, register this app, send you to sign in in your browser with PKCE, and
// receive the result on a one-off local address. Tokens are refreshed when they run out.
const crypto = require("node:crypto");
const http = require("node:http");

const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
const CLIENT_NAME = "Meeting Notes";

class AuthRequiredError extends Error {
  constructor(resourceMetadata = null) {
    super("This server needs you to sign in.");
    this.code = "auth-required";
    this.resourceMetadata = resourceMetadata;
  }
}

const base64url = (buffer) => buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function pkce() {
  const verifier = base64url(crypto.randomBytes(48));
  return { verifier, challenge: base64url(crypto.createHash("sha256").update(verifier).digest()) };
}

// Only https, except servers on this Mac.
function checkUrl(value, what) {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error(`The ${what} isn't on a secure (https) address, so sign-in was stopped.`);
  return url;
}

/** The resource_metadata URL from a 401's WWW-Authenticate header, if any. */
function resourceMetadataFrom(header) {
  return /resource_metadata="([^"]+)"/i.exec(String(header || ""))?.[1] || null;
}

async function getJson(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { accept: "application/json", "mcp-protocol-version": "2025-06-18" } });
  if (!response.ok) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// RFC 8414 / OpenID discovery URLs for an issuer, path-aware.
function metadataUrls(issuer) {
  const url = new URL(issuer);
  const pathPart = url.pathname.replace(/\/$/, "");
  const origin = url.origin;
  return pathPart && pathPart !== "/"
    ? [`${origin}/.well-known/oauth-authorization-server${pathPart}`, `${origin}/.well-known/openid-configuration${pathPart}`, `${origin}${pathPart}/.well-known/openid-configuration`]
    : [`${origin}/.well-known/oauth-authorization-server`, `${origin}/.well-known/openid-configuration`];
}

/** Finds where to sign in for an MCP server URL. */
async function discover(serverUrl, { fetchImpl = globalThis.fetch, resourceMetadata = null } = {}) {
  const server = checkUrl(serverUrl, "server");
  const resource = `${server.origin}${server.pathname}`.replace(/\/$/, "") || server.origin;
  const candidates = [
    resourceMetadata,
    `${server.origin}/.well-known/oauth-protected-resource${server.pathname.replace(/\/$/, "")}`,
    `${server.origin}/.well-known/oauth-protected-resource`,
  ].filter(Boolean);
  let protectedResource = null;
  for (const candidate of [...new Set(candidates)]) {
    protectedResource = await getJson(fetchImpl, candidate).catch(() => null);
    if (protectedResource) break;
  }
  // Older servers (spec 2025-03-26) are their own authorization server.
  const issuer = protectedResource?.authorization_servers?.[0] || server.origin;
  let metadata = null;
  for (const candidate of metadataUrls(issuer)) {
    metadata = await getJson(fetchImpl, candidate).catch(() => null);
    if (metadata?.authorization_endpoint) break;
  }
  const origin = new URL(issuer).origin;
  metadata ||= { authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register` };
  checkUrl(metadata.authorization_endpoint, "sign-in page");
  checkUrl(metadata.token_endpoint, "token address");
  if (metadata.registration_endpoint) checkUrl(metadata.registration_endpoint, "registration address");
  if (metadata.code_challenge_methods_supported && !metadata.code_challenge_methods_supported.includes("S256")) {
    throw new Error("That server's sign-in doesn't support PKCE, so it can't be used safely.");
  }
  return {
    resource: protectedResource?.resource || resource,
    scopes: protectedResource?.scopes_supported || metadata.scopes_supported || [],
    authorizationEndpoint: metadata.authorization_endpoint,
    tokenEndpoint: metadata.token_endpoint,
    registrationEndpoint: metadata.registration_endpoint || null,
  };
}

async function register(found, redirectUri, { fetchImpl = globalThis.fetch } = {}) {
  if (!found.registrationEndpoint) throw new Error("That server doesn't let apps register themselves, so it needs a client ID from its owner.");
  const response = await fetchImpl(found.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!response.ok) throw new Error(`The server wouldn't register Meeting Notes (${response.status}).`);
  const client = await response.json();
  if (!client.client_id) throw new Error("The server didn't give Meeting Notes a client ID.");
  return { clientId: client.client_id, clientSecret: client.client_secret || null };
}

async function tokenRequest(tokenEndpoint, params, client, { fetchImpl = globalThis.fetch } = {}) {
  const body = new URLSearchParams({ ...params, client_id: client.clientId });
  const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (client.clientSecret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString("base64")}`;
  const response = await fetchImpl(tokenEndpoint, { method: "POST", headers, body: body.toString() });
  let data = {};
  try {
    data = await response.json();
  } catch {
    // Not JSON.
  }
  if (!response.ok || !data.access_token) {
    const reason = data.error_description || data.error || `status ${response.status}`;
    throw Object.assign(new Error(`Sign-in didn't finish: ${reason}.`), { code: data.error || "token-failed" });
  }
  return data;
}

const tokensFrom = (data, previous = {}) => ({
  accessToken: data.access_token,
  refreshToken: data.refresh_token || previous.refreshToken || null,
  expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : null,
});

const CLOSE_PAGE = (message) =>
  `<!doctype html><meta charset="utf-8"><title>Meeting Notes</title><body style="font:15px -apple-system,system-ui;background:#18181b;color:#e4e4e7;display:grid;place-items:center;height:90vh"><p>${message}</p>`;

/** Waits for the browser to come back to a one-off local address. */
function listenForCallback({ timeoutMs = SIGN_IN_TIMEOUT_MS } = {}) {
  return new Promise((resolveListening, rejectListening) => {
    let settle;
    const result = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    const server = http.createServer((request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        response.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(CLOSE_PAGE(error ? "Sign-in was cancelled. You can close this tab." : "Signed in. You can close this tab and go back to Meeting Notes."));
      finish(error ? new Error(url.searchParams.get("error_description") || "Sign-in was cancelled.") : null, { code: url.searchParams.get("code"), state: url.searchParams.get("state") });
    });
    const timer = setTimeout(() => finish(new Error("Sign-in timed out. Try again.")), timeoutMs);
    function finish(error, value) {
      clearTimeout(timer);
      // Browsers keep connections open; don't let them hold the one-off address.
      server.close();
      setTimeout(() => server.closeAllConnections(), 1000).unref();
      if (error) settle.reject(error);
      else settle.resolve(value);
    }
    server.on("error", rejectListening);
    server.listen(0, "127.0.0.1", () => {
      resolveListening({ redirectUri: `http://127.0.0.1:${server.address().port}/callback`, result, cancel: () => finish(new Error("Sign-in was cancelled.")) });
    });
  });
}

/**
 * The whole sign-in: discover, register, browser, tokens. openBrowser opens a URL in your browser.
 * Returns what to keep (encrypted) for later requests and refreshes.
 */
async function signIn(serverUrl, { openBrowser, fetchImpl = globalThis.fetch, resourceMetadata = null, clientId = null } = {}) {
  const found = await discover(serverUrl, { fetchImpl, resourceMetadata });
  const listening = await listenForCallback();
  try {
    const client = clientId ? { clientId, clientSecret: null } : await register(found, listening.redirectUri, { fetchImpl });
    const { verifier, challenge } = pkce();
    const state = base64url(crypto.randomBytes(24));
    const authorize = new URL(found.authorizationEndpoint);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", client.clientId);
    authorize.searchParams.set("redirect_uri", listening.redirectUri);
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("resource", found.resource);
    if (found.scopes.length) authorize.searchParams.set("scope", found.scopes.join(" "));
    await openBrowser(authorize.href);
    const callback = await listening.result;
    if (callback.state !== state) throw new Error("Sign-in came back for a different request, so it was ignored. Try again.");
    if (!callback.code) throw new Error("Sign-in didn't return a code.");
    const data = await tokenRequest(
      found.tokenEndpoint,
      { grant_type: "authorization_code", code: callback.code, redirect_uri: listening.redirectUri, code_verifier: verifier, resource: found.resource },
      client,
      { fetchImpl },
    );
    return { ...client, tokenEndpoint: found.tokenEndpoint, resource: found.resource, ...tokensFrom(data) };
  } catch (error) {
    listening.cancel();
    listening.result.catch(() => {});
    throw error;
  }
}

/** A fresh access token, refreshing it if it has run out. Returns the updated session. */
async function refresh(session, { fetchImpl = globalThis.fetch } = {}) {
  if (!session.refreshToken) throw new AuthRequiredError();
  try {
    const data = await tokenRequest(session.tokenEndpoint, { grant_type: "refresh_token", refresh_token: session.refreshToken, resource: session.resource }, session, { fetchImpl });
    return { ...session, ...tokensFrom(data, session) };
  } catch (error) {
    if (error.code === "invalid_grant") throw new AuthRequiredError();
    throw error;
  }
}

const expiring = (session) => Boolean(session.expiresAt && session.expiresAt - Date.now() < 60_000);

module.exports = { AuthRequiredError, discover, expiring, listenForCallback, pkce, refresh, resourceMetadataFrom, signIn };
