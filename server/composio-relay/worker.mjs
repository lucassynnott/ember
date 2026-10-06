// Ember's Composio relay: lets the desktop app connect Linear, Notion and Google Drive and
// send action items and notes, without each user needing a Composio account.
//
// The Composio project API key lives only here (a Worker secret), never in the app. Each app
// install sends a random secret; its Composio user id is derived from it, so one install can't
// see or use another's connections. Only the tools below can be run.
const API = "https://backend.composio.dev/api/v3";

// Toolkit → the tools the app may run with it. Sign-in configs are restricted to these too.
const TOOLKITS = {
  linear: ["LINEAR_LIST_LINEAR_TEAMS", "LINEAR_CREATE_LINEAR_ISSUE", "LINEAR_LIST_LINEAR_STATES", "LINEAR_UPDATE_ISSUE"],
  notion: ["NOTION_SEARCH_NOTION_PAGE", "NOTION_FETCH_DATABASE", "NOTION_INSERT_ROW_DATABASE", "NOTION_UPDATE_ROW_DATABASE"],
  googledrive: ["GOOGLEDRIVE_FIND_FOLDER", "GOOGLEDRIVE_CREATE_FILE_FROM_TEXT", "GOOGLEDRIVE_GET_FILE_METADATA", "GOOGLEDRIVE_MOVE_FILE"],
  googledocs: ["GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN"],
  // Sharing recordings: setup runs through /v1/cloudflare below, limited to Ember's own bucket and Worker.
  cloudflare: ["CLOUDFLARE_LIST_ACCOUNTS"],
};
// Composio has no managed sign-in for these: people enter their own key in Composio's form.
const OWN_KEY_TOOLKITS = { cloudflare: "API_KEY" };
// Bump when the tool lists change, so new sign-in configs are made with the new restrictions.
const CONFIG_VERSION = "v2";
const TOOL_TOOLKIT = Object.fromEntries(Object.entries(TOOLKITS).flatMap(([toolkit, tools]) => tools.map((tool) => [tool, toolkit])));
const MAX_BODY = 1_000_000;
const RATE_PER_MINUTE = 60;

const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (status, message) => json(status, { error: message });

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function composio(env, method, path, { query, body } = {}) {
  const url = new URL(`${API}${path}`);
  for (const [key, value] of Object.entries(query || {})) if (value !== undefined) url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
  const response = await fetch(url, {
    method,
    headers: { "x-api-key": env.COMPOSIO_API_KEY, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  if (!response.ok) {
    const message = data?.error?.message || data?.message || `Composio answered ${response.status}`;
    throw Object.assign(new Error(message), { status: response.status });
  }
  return data;
}

// Finds this project's Composio-managed sign-in config for a toolkit, or creates one limited to our tools.
const authConfigs = new Map();
async function authConfigFor(env, toolkit) {
  const cacheKey = `${env.COMPOSIO_API_KEY}:${toolkit}`;
  if (authConfigs.has(cacheKey)) return authConfigs.get(cacheKey);
  // An internal ID: existing auth configs are found by it, so it keeps the app's old name.
  const name = `Meeting Notes · ${toolkit} · ${CONFIG_VERSION}`;
  const ownKey = OWN_KEY_TOOLKITS[toolkit];
  const listed = await composio(env, "GET", "/auth_configs", { query: { toolkit_slug: toolkit, is_composio_managed: !ownKey, limit: 50 } });
  let config = (listed?.items || []).find((item) => item.name === name && !item.is_disabled && item.status !== "DISABLED");
  if (!config) {
    const created = await composio(env, "POST", "/auth_configs", {
      body: {
        toolkit: { slug: toolkit },
        auth_config: ownKey
          ? { type: "use_custom_auth", authScheme: ownKey, credentials: {}, name, restrict_to_following_tools: TOOLKITS[toolkit] }
          : { type: "use_composio_managed_auth", name, restrict_to_following_tools: TOOLKITS[toolkit] },
      },
    });
    config = created?.auth_config || created;
  }
  if (!config?.id) throw new Error(`Couldn't set up sign-in for ${toolkit}.`);
  authConfigs.set(cacheKey, config.id);
  return config.id;
}

// Best effort, per Worker instance: stops one install from hammering the relay.
const recent = new Map();
function rateLimited(userId) {
  const now = Date.now();
  const times = (recent.get(userId) || []).filter((time) => now - time < 60_000);
  times.push(now);
  recent.set(userId, times);
  if (recent.size > 5000) recent.clear();
  return times.length > RATE_PER_MINUTE;
}

async function ownedAccount(env, userId, id) {
  if (!/^[\w-]{4,80}$/.test(String(id || ""))) return null;
  const account = await composio(env, "GET", `/connected_accounts/${encodeURIComponent(id)}`).catch(() => null);
  return account && account.user_id === userId ? account : null;
}

// The only Cloudflare calls the app may make: its account list, and setting up and updating its own
// "ember-…" bucket and Worker. Nothing can read or change anything else in the account.
const ACCOUNT = "/accounts/[0-9a-f]{32}";
const OWN_NAME = /^ember-[a-z0-9-]{1,40}$/;
const CLOUDFLARE_RULES = [
  { method: "GET", path: /^\/accounts$/ },
  { method: "GET", path: new RegExp(`^${ACCOUNT}/r2/buckets$`) },
  { method: "POST", path: new RegExp(`^${ACCOUNT}/r2/buckets$`), body: (body) => OWN_NAME.test(body?.name) },
  { method: "GET", path: new RegExp(`^${ACCOUNT}/workers/subdomain$`) },
  { method: "PUT", path: new RegExp(`^${ACCOUNT}/workers/subdomain$`), body: (body) => OWN_NAME.test(body?.subdomain), onlyIfNoSubdomain: true },
  { method: "GET", path: new RegExp(`^${ACCOUNT}/workers/workers$`) },
  { method: "POST", path: new RegExp(`^${ACCOUNT}/workers/workers$`), body: (body) => OWN_NAME.test(body?.name) },
  // Ember Drive: one storage key, limited to object read and write in Ember's own buckets.
  { method: "GET", path: new RegExp(`^${ACCOUNT}/tokens/permission_groups$`) },
  { method: "POST", path: new RegExp(`^(${ACCOUNT})/tokens$`), body: driveTokenAllowed, driveToken: true },
  {
    method: "POST",
    path: new RegExp(`^(${ACCOUNT})/workers/workers/([\\w-]{1,64})/versions\\?deploy=true$`),
    body: (body) => (body?.bindings || []).every((binding) => binding.type !== "r2_bucket" || OWN_NAME.test(binding.bucket_name)),
    ownWorker: true,
  },
];
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

// The R2 key Ember Drive asks for: named "ember-drive…", object read/write only, on "ember-…" buckets only.
const R2_OBJECT_PERMISSIONS = new Set(["Workers R2 Storage Bucket Item Write", "Workers R2 Storage Bucket Item Read"]);
function driveTokenAllowed(body) {
  if (!/^ember-drive[a-z0-9 -]{0,40}$/.test(String(body?.name || ""))) return false;
  const policies = Array.isArray(body?.policies) ? body.policies : [];
  if (!policies.length) return false;
  return policies.every(
    (policy) =>
      policy?.effect === "allow" &&
      Object.keys(policy.resources || {}).length > 0 &&
      Object.keys(policy.resources).every((resource) => /^com\.cloudflare\.edge\.r2\.bucket\.[0-9a-f]{32}_default_ember-[a-z0-9-]{1,40}$/.test(resource)) &&
      (policy.permission_groups || []).length > 0 &&
      policy.permission_groups.every((group) => R2_OBJECT_PERMISSIONS.has(group?.name)),
  );
}

async function cloudflareProxy(env, accountId, method, path, body) {
  const result = await composio(env, "POST", "/tools/execute/proxy", {
    body: { connected_account_id: accountId, endpoint: `${CLOUDFLARE_API}${path}`, method, ...(body === undefined ? {} : { body }) },
  });
  return { status: result?.status ?? 200, data: result?.data ?? null };
}

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>Ember</title><body style="font:15px -apple-system,system-ui;background:#18181b;color:#e4e4e7;display:grid;place-items:center;height:90vh"><p>Connected. You can close this tab and go back to Ember.</p>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/connected") return new Response(DONE_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (request.method === "GET" && url.pathname === "/health") return json(200, { ok: true, toolkits: Object.keys(TOOLKITS) });
    if (!env.COMPOSIO_API_KEY) return fail(503, "The relay isn't configured yet.");

    const secret = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!/^[0-9a-f]{64}$/.test(secret)) return fail(401, "Missing or malformed install secret.");
    const userId = `mn_${(await sha256Hex(`meeting-notes:${secret}`)).slice(0, 40)}`;
    if (rateLimited(userId)) return fail(429, "Too many requests. Try again in a minute.");

    let body = {};
    if (request.method === "POST") {
      const text = await request.text();
      if (text.length > MAX_BODY) return fail(413, "That request is too large.");
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        return fail(400, "Invalid JSON.");
      }
    }

    try {
      if (request.method === "POST" && url.pathname === "/v1/connect") {
        const toolkit = String(body.toolkit || "");
        if (!TOOLKITS[toolkit]) return fail(400, "That app isn't supported.");
        const link = await composio(env, "POST", "/connected_accounts/link", {
          body: { auth_config_id: await authConfigFor(env, toolkit), user_id: userId, callback_url: `${url.origin}/connected` },
        });
        return json(200, { redirectUrl: link.redirect_url, connectionId: link.connected_account_id, expiresAt: link.expires_at });
      }

      if (request.method === "GET" && url.pathname === "/v1/connections") {
        const listed = await composio(env, "GET", "/connected_accounts", { query: { user_ids: [userId], toolkit_slugs: Object.keys(TOOLKITS), limit: 100 } });
        const connections = (listed?.items || [])
          .filter((item) => item.user_id === userId)
          .map((item) => ({ id: item.id, toolkit: item.toolkit?.slug, status: item.status, createdAt: item.created_at }));
        return json(200, { connections });
      }

      const remove = /^\/v1\/connections\/([\w-]+)$/.exec(url.pathname);
      if (request.method === "DELETE" && remove) {
        if (!(await ownedAccount(env, userId, remove[1]))) return fail(404, "No such connection.");
        await composio(env, "DELETE", `/connected_accounts/${encodeURIComponent(remove[1])}`);
        return json(200, { ok: true });
      }

      if (request.method === "POST" && url.pathname === "/v1/execute") {
        const tool = String(body.tool || "");
        const toolkit = TOOL_TOOLKIT[tool];
        if (!toolkit) return fail(403, "That action isn't allowed.");
        const account = await ownedAccount(env, userId, body.connectionId);
        if (!account || account.toolkit?.slug !== toolkit) return fail(404, `Connect ${toolkit} first.`);
        if (account.status !== "ACTIVE") return fail(409, `The ${toolkit} connection needs signing in again.`);
        const result = await composio(env, "POST", `/tools/execute/${tool}`, {
          body: { user_id: userId, connected_account_id: account.id, arguments: body.arguments && typeof body.arguments === "object" ? body.arguments : {} },
        });
        return json(200, { successful: result?.successful !== false, data: result?.data ?? null, error: result?.error || null });
      }

      if (request.method === "POST" && url.pathname === "/v1/cloudflare") {
        const method = String(body.method || "GET").toUpperCase();
        const path = String(body.path || "");
        const rule = CLOUDFLARE_RULES.find((candidate) => candidate.method === method && candidate.path.test(path));
        if (!rule || (rule.body && !rule.body(body.body))) return fail(403, "That Cloudflare request isn't allowed.");
        const account = await ownedAccount(env, userId, body.connectionId);
        if (!account || account.toolkit?.slug !== "cloudflare") return fail(404, "Connect Cloudflare first.");
        if (account.status !== "ACTIVE") return fail(409, "The Cloudflare connection needs signing in again.");
        if (rule.onlyIfNoSubdomain) {
          const current = await cloudflareProxy(env, account.id, "GET", path);
          if (current.data?.result?.subdomain) return fail(409, "This account already has a workers.dev subdomain.");
        }
        if (rule.driveToken) {
          // The permission IDs must really be R2 object read/write, whatever names the request gives them.
          const [, accountPath] = rule.path.exec(path);
          const groups = await cloudflareProxy(env, account.id, "GET", `${accountPath}/tokens/permission_groups`);
          const names = new Map((groups.data?.result || []).map((group) => [group.id, group.name]));
          const ok = body.body.policies.every((policy) => policy.permission_groups.every((group) => R2_OBJECT_PERMISSIONS.has(names.get(group.id))));
          if (!ok) return fail(403, "That Cloudflare request isn't allowed.");
        }
        if (rule.ownWorker) {
          // Only Ember's own Worker can be replaced, never another of the account's Workers.
          const [, accountPath, workerId] = rule.path.exec(path);
          const worker = await cloudflareProxy(env, account.id, "GET", `${accountPath}/workers/workers/${workerId}`);
          if (!OWN_NAME.test(worker.data?.result?.name || "")) return fail(403, "Only Ember's own Worker can be updated.");
        }
        const answer = await cloudflareProxy(env, account.id, method, path, body.body);
        return json(200, answer);
      }

      return fail(404, "Not found.");
    } catch (error) {
      return fail(error.status && error.status < 500 ? 400 : 502, error.message || "Something went wrong.");
    }
  },
};
