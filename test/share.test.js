const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ShareService, ShareStore, captionsFrom, hashPassword, newShareId, retime } = require("../src/cloudflare-share");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "src", "share-worker.js"), "utf8");
const loadWorker = () => import(`data:text/javascript;base64,${Buffer.from(SOURCE).toString("base64")}`).then((module) => module.default);

// Enough of R2 for the Worker: objects, ranges from a Range header, and multipart uploads.
function memoryBucket() {
  const objects = new Map();
  const uploads = new Map();
  const toBytes = async (body) => (typeof body === "string" ? Buffer.from(body) : Buffer.from(await new Response(body).arrayBuffer()));
  const object = (key, bytes, range) => {
    const slice = range ? bytes.subarray(range.offset, range.offset + range.length) : bytes;
    return {
      key,
      size: bytes.length,
      httpEtag: `"${key}"`,
      range,
      body: new Response(slice).body,
      text: async () => slice.toString(),
    };
  };
  return {
    objects,
    async get(key, options = {}) {
      const bytes = objects.get(key);
      if (!bytes) return null;
      const header = options.range?.get?.("range");
      const match = header && /^bytes=(\d*)-(\d*)$/.exec(header);
      if (!match) return object(key, bytes, null);
      if (!match[1]) return { ...object(key, bytes, null), range: { offset: undefined, length: undefined, suffix: Number(match[2]) }, body: new Response(bytes.subarray(bytes.length - Number(match[2]))).body };
      const offset = Number(match[1]);
      const end = match[2] ? Number(match[2]) : bytes.length - 1;
      return object(key, bytes, { offset, length: end - offset + 1, suffix: undefined });
    },
    async put(key, body) {
      objects.set(key, await toBytes(body));
    },
    async list({ prefix }) {
      return { objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) };
    },
    async delete(keys) {
      for (const key of [].concat(keys)) objects.delete(key);
    },
    async createMultipartUpload(key) {
      const uploadId = `u${uploads.size + 1}`;
      uploads.set(uploadId, { key, parts: new Map() });
      return { uploadId };
    },
    resumeMultipartUpload(key, uploadId) {
      const upload = uploads.get(uploadId);
      return {
        async uploadPart(number, body) {
          upload.parts.set(number, await toBytes(body));
          return { partNumber: number, etag: `e${number}` };
        },
        async complete(parts) {
          objects.set(key, Buffer.concat(parts.map((part) => upload.parts.get(part.partNumber))));
          uploads.delete(uploadId);
        },
        async abort() {
          uploads.delete(uploadId);
        },
      };
    },
  };
}

// Cloudflare's API as Ember sees it through Composio, enough for setup.
function fakeCloudflare() {
  const calls = [];
  const state = { buckets: [], workers: [], subdomain: null, versions: [] };
  const ok = (result) => ({ success: true, errors: [], result });
  const api = async (method, route, body) => {
    calls.push(`${method} ${route}`);
    if (route === "/accounts") return ok([{ id: "a".repeat(32), name: "Alex's account" }]);
    if (route.endsWith("/r2/buckets") && method === "GET") return ok({ buckets: state.buckets });
    if (route.endsWith("/r2/buckets") && method === "POST") return state.buckets.push({ name: body.name }), ok({ name: body.name });
    if (route.endsWith("/workers/subdomain") && method === "GET") return state.subdomain ? ok({ subdomain: state.subdomain }) : { success: false, errors: [{ code: 10007, message: "no subdomain" }] };
    if (route.endsWith("/workers/subdomain") && method === "PUT") return (state.subdomain = body.subdomain), ok({ subdomain: body.subdomain });
    if (route.endsWith("/workers/workers") && method === "GET") return ok(state.workers);
    if (route.endsWith("/workers/workers") && method === "POST") {
      const worker = { id: "w1", name: body.name };
      state.workers.push(worker);
      return ok(worker);
    }
    if (route.includes("/versions?deploy=true")) return state.versions.push(body), ok({ id: "v1" });
    throw new Error(`unexpected ${method} ${route}`);
  };
  return { api, calls, state };
}

async function setUp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-share-"));
  const worker = await loadWorker();
  const env = { BUCKET: memoryBucket(), UPLOAD_SECRET: null };
  const cloudflare = fakeCloudflare();
  const store = new ShareStore({ filePath: path.join(dir, "share.json"), encrypt: (value) => `enc:${value}`, decrypt: (value) => value.slice(4) });
  const fetchImpl = async (url, init = {}) => worker.fetch(new Request(url, init), env);
  const service = new ShareService({ cloudflare: cloudflare.api, store, fetchImpl, workerSource: SOURCE, pollMs: 1 });
  // The deployed Worker gets the secret Ember chose.
  const deploy = cloudflare.api;
  cloudflare.api = service.cloudflare = async (method, route, body) => {
    if (route.includes("/versions")) env.UPLOAD_SECRET = body.bindings.find((binding) => binding.name === "UPLOAD_SECRET").text;
    return deploy(method, route, body);
  };
  return { dir, worker, env, cloudflare, store, service, view: (route, init) => worker.fetch(new Request(`https://ember-share.ember-abc.workers.dev${route}`, init), env) };
}

test("ids, captions, passwords and edit times", () => {
  const ids = new Set(Array.from({ length: 200 }, newShareId));
  assert.equal(ids.size, 200);
  assert.ok([...ids].every((id) => /^[A-Za-z0-9]{12}$/.test(id)));
  assert.equal(captionsFrom([{ start: 1.5, end: 3, text: "Hello --> there" }]), "WEBVTT\n\n00:00:01.500 --> 00:00:03.000\nHello → there\n");
  assert.equal(captionsFrom([]), null);
  const password = hashPassword("pw", "salt");
  assert.equal(password.hash.length, 64);
  const project = { segments: [{ start: 0, end: 10, speed: 1, removed: true }, { start: 10, end: 30, speed: 2, removed: false }] };
  assert.deepEqual(retime(project, [{ start: 5, end: 8, text: "cut" }, { start: 14, end: 18, text: "kept" }]), [{ start: 2, end: 4, text: "kept" }]);
  assert.deepEqual(retime(null, [{ start: 1 }]), [{ start: 1 }]);
  const reordered = { clips: [{ start: 20, end: 30, speed: 1 }, { start: 0, end: 10, speed: 2 }] };
  assert.deepEqual(retime(reordered, [{ start: 4, end: 6, text: "early" }, { start: 22, end: 24, text: "late" }, { start: 15, text: "cut" }]), [
    { start: 2, end: 4, text: "late" },
    { start: 12, end: 13, text: "early" },
  ]);
});

test("setup makes the bucket, a subdomain and the Worker, and can run again", async () => {
  const { cloudflare, service, store, dir } = await setUp();
  try {
    const config = await service.setup();
    assert.match(config.url, /^https:\/\/ember-share\.ember-[0-9a-f]{6}\.workers\.dev$/);
    assert.equal(cloudflare.state.buckets[0].name, "ember-shares");
    assert.equal(cloudflare.state.versions.length, 1);
    assert.ok(cloudflare.state.versions[0].modules[0].content_base64.length > 1000);
    assert.ok(store.secret().length === 64);
    assert.ok(fs.readFileSync(path.join(dir, "share.json"), "utf8").includes("enc:"));
    const secret = store.secret();
    await service.setup();
    assert.equal(cloudflare.state.workers.length, 1, "no second Worker");
    assert.equal(store.secret(), secret, "the secret is kept");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R2 switched off sends you to Cloudflare", async () => {
  const { service, cloudflare, dir } = await setUp();
  const inner = service.cloudflare;
  service.cloudflare = async (method, route, body) =>
    route.endsWith("/r2/buckets") ? { success: false, errors: [{ code: 10042, message: "Please enable R2 through the Cloudflare Dashboard." }] } : inner(method, route, body);
  try {
    await assert.rejects(service.setup(), (error) => error.code === "r2" && error.url.includes("/r2/overview"));
    assert.ok(!cloudflare.calls.some((call) => call.includes("versions")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sharing uploads in parts, and the page, ranges, passwords and deleting work", async () => {
  const { service, env, view, dir } = await setUp();
  try {
    await service.setup();
    const video = path.join(dir, "video.mp4");
    const bytes = Buffer.alloc(23 * 1024 * 1024, 7);
    bytes.write("ftypmp42", 4);
    fs.writeFileSync(video, bytes);
    const thumb = path.join(dir, "thumb.jpg");
    fs.writeFileSync(thumb, Buffer.from([0xff, 0xd8, 0xff]));
    const progress = [];
    const details = {
      title: "Pricing <script>alert(1)</script>",
      summary: "Shows the bug.",
      chapters: [{ start: 0, title: "Start" }, { start: 40, title: "The bug" }],
      transcript: [{ start: 0, end: 4, text: "Hi Priya" }],
      duration: 74,
      width: 1920,
      height: 1080,
      createdAt: "2026-10-05T10:00:00.000Z",
      download: false,
      password: null,
    };
    const shared = await service.share({ video, thumb, details, onProgress: (value) => progress.push(value) });
    assert.match(shared.url, /\/v\/[A-Za-z0-9]{12}$/);
    assert.deepEqual(progress.map((value) => Math.round(value * 100)), [43, 87, 100]);
    assert.equal(env.BUCKET.objects.get(`${shared.id}/video.mp4`).length, bytes.length);

    const page = await view(`/v/${shared.id}`);
    const markup = await page.text();
    assert.equal(page.status, 200);
    assert.ok(markup.includes("Pricing &lt;script&gt;"), "titles are escaped");
    assert.ok(!markup.includes("<script>alert"), "no injected script");
    assert.ok(markup.includes('property="og:video"') && markup.includes("captions.vtt") && markup.includes("Hi Priya"));
    assert.ok(!markup.includes("Download"), "no download when it's off");
    assert.match(page.headers.get("content-security-policy"), /script-src 'nonce-/);

    const range = await view(`/v/${shared.id}/video.mp4`, { headers: { range: "bytes=4-11" } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("content-range"), `bytes 4-11/${bytes.length}`);
    assert.equal(await range.text(), "ftypmp42");
    assert.equal((await view(`/v/${shared.id}/video.mp4?download=1`)).status, 404);

    // A password, then the right and wrong one.
    await service.update(shared.id, { ...details, hasThumb: true, password: hashPassword("open sesame") });
    const locked = await (await view(`/v/${shared.id}`)).text();
    assert.ok(locked.includes('type="password"') && !locked.includes("og:video"));
    assert.equal((await view(`/v/${shared.id}/video.mp4`)).status, 404);
    const wrong = await view(`/v/${shared.id}`, { method: "POST", body: new URLSearchParams({ password: "nope" }) });
    assert.equal(wrong.status, 401);
    const right = await view(`/v/${shared.id}`, { method: "POST", body: new URLSearchParams({ password: "open sesame" }), redirect: "manual" });
    assert.equal(right.status, 303);
    const key = new URL(right.headers.get("location")).searchParams.get("k");
    assert.equal((await view(`/v/${shared.id}/video.mp4?k=${key}`, { headers: { range: "bytes=0-3" } })).status, 206);

    // Expired, then deleted.
    await service.update(shared.id, { ...details, expiresAt: "2020-01-01T00:00:00.000Z" });
    assert.equal((await view(`/v/${shared.id}`)).status, 410);
    await service.remove(shared.id);
    assert.equal((await view(`/v/${shared.id}`)).status, 404);
    assert.equal([...env.BUCKET.objects.keys()].length, 0);

    // Only Ember can upload.
    assert.equal((await view(`/api/shares/${shared.id}/files/share.json`, { method: "PUT", body: "{}", headers: { authorization: "Bearer nope" } })).status, 401);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
