// Ember's share Worker. Ember publishes this into the user's own Cloudflare account, with an R2
// bucket bound as BUCKET and a secret only that copy of Ember knows as UPLOAD_SECRET. It serves
// each shared video's page and files, and takes uploads from Ember.
//
//   GET  /v/<id>                    the page: player, summary, chapters, transcript
//   POST /v/<id>                    the password, for a protected video
//   GET  /v/<id>/video.mp4          the video (with byte ranges, so it seeks)
//   GET  /v/<id>/thumb.jpg          its poster
//   GET  /v/<id>/captions.vtt       its captions
//   /api/…                          Ember only (Bearer UPLOAD_SECRET): uploads, details, deleting
//
// Nothing is listed: a video is only found by its unguessable id. Files live under "<id>/".

const VERSION = "2";
const ID = /^[A-Za-z0-9]{10,24}$/;
const FILES = { "video.mp4": "video/mp4", "thumb.jpg": "image/jpeg", "captions.vtt": "text/vtt; charset=utf-8" };
const MAX_DETAILS = 1_500_000;

const encoder = new TextEncoder();

function html(status, body, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function escape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function clock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(text))).slice(0, 40);
}

async function sha256(text) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

// Compared in constant time, so the answer's timing gives nothing away.
function same(left, right) {
  const a = encoder.encode(String(left));
  const b = encoder.encode(String(right));
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

async function details(env, id) {
  const object = await env.BUCKET.get(`${id}/share.json`);
  if (!object) return null;
  try {
    return JSON.parse(await object.text());
  } catch {
    return null;
  }
}

const expired = (share) => Boolean(share.expiresAt && Date.parse(share.expiresAt) < Date.now());

/** The key a viewer gets once they've given the password, good for that password only. */
const accessKey = (env, id, share) => hmac(env.UPLOAD_SECRET, `${id}:${share.password?.hash || ""}`);

async function allowed(env, id, share, url) {
  if (!share.password) return true;
  const given = url.searchParams.get("k") || "";
  return given && same(given, await accessKey(env, id, share));
}

/* The page */

const STYLE = `
:root{color-scheme:dark;--bg:#121212;--panel:#1b1b1b;--line:rgb(255 255 255/9%);--text:#ededed;--muted:rgb(255 255 255/62%);--faint:rgb(255 255 255/42%);--ember:#ff7a2f}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}main{max-width:1180px;margin:0 auto;padding:28px 20px 56px}
.top{display:flex;align-items:center;gap:10px;margin-bottom:22px;color:var(--muted);font-size:14px;text-decoration:none}
.top svg{width:22px;height:22px}
.player{border-radius:16px;overflow:hidden;background:#000;border:1px solid var(--line);box-shadow:0 30px 90px rgb(0 0 0/.5)}
video{display:block;width:100%;max-height:78vh;background:#000}
.grid{display:grid;gap:28px;margin-top:26px}@media(min-width:980px){.grid{grid-template-columns:minmax(0,1fr) 360px}}
h1{margin:0;font-size:clamp(24px,3.2vw,34px);line-height:1.15;letter-spacing:-.025em;font-weight:650}
.meta{margin:8px 0 0;color:var(--faint);font-size:14px}
.summary{margin:18px 0 0;font-size:16.5px;color:rgb(255 255 255/85%)}
.actions{display:flex;gap:10px;margin-top:18px;flex-wrap:wrap}
.button{display:inline-flex;align-items:center;gap:8px;height:38px;padding:0 16px;border-radius:999px;border:1px solid rgb(255 255 255/16%);text-decoration:none;font-size:14px;color:var(--text);background:none;cursor:pointer}
.button:hover{border-color:rgb(255 255 255/30%)}
h2{margin:30px 0 8px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--faint);font-weight:600}
ol{list-style:none;margin:0;padding:0}
.chapter,.line{display:flex;gap:14px;width:100%;text-align:left;background:none;border:0;color:inherit;font:inherit;padding:8px 10px;border-radius:10px;cursor:pointer}
.chapter:hover,.line:hover{background:rgb(255 255 255/5%)}
.time{flex:none;width:44px;color:var(--faint);font-size:13px;font-variant-numeric:tabular-nums;padding-top:2px}
.on{background:rgb(255 122 47/9%)}.on .time{color:var(--ember)}
aside{background:var(--panel);border:1px solid var(--line);border-radius:16px;align-self:start;max-height:78vh;display:flex;flex-direction:column}
aside h2{margin:0;padding:14px 18px;border-bottom:1px solid var(--line)}
aside ol{overflow-y:auto;padding:8px}
.line span:last-child{font-size:14.5px;color:rgb(255 255 255/78%)}
footer{margin-top:44px;color:var(--faint);font-size:13px}footer a{color:var(--muted)}
.center{min-height:80vh;display:grid;place-items:center;text-align:center}
form{display:flex;gap:10px;justify-content:center;margin-top:18px}
input{height:40px;border-radius:999px;border:1px solid rgb(255 255 255/18%);background:#1b1b1b;color:var(--text);padding:0 16px;font:inherit;min-width:220px}
`;

const MARK = `<svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="e" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffc15e"/><stop offset=".5" stop-color="#ff7a2f"/><stop offset="1" stop-color="#e8492c"/></linearGradient></defs>${[6, 12, 16, 10, 6]
  .map((height, index) => `<rect x="${2.4 + index * 4.1}" y="${12 - (height * 1.25) / 2}" width="2.6" height="${height * 1.25}" rx="1.3" fill="url(#e)"/>`)
  .join("")}</svg>`;

function page({ title, head = "", body }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escape(title)}</title>${head}<style>${STYLE}</style></head><body>${body}</body></html>`;
}

function security(nonce) {
  return {
    "content-security-policy": `default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  };
}

function message(title, text, extra = "") {
  return page({ title, body: `<main class="center"><div>${MARK.replace("<svg", '<svg style="width:40px;height:40px"')}<h1 style="margin-top:14px">${escape(title)}</h1><p class="meta">${escape(text)}</p>${extra}</div></main>` });
}

async function viewer(request, env, id, url) {
  const share = await details(env, id);
  if (!share) return html(404, message("Video not found", "This link doesn't go anywhere. It may have been deleted."));
  if (expired(share)) return html(410, message("This video has expired", "The person who shared it set it to stop working after a while."));

  const nonce = crypto.randomUUID().replace(/-/g, "");
  if (share.password) {
    if (request.method === "POST") {
      const form = await request.formData().catch(() => null);
      const given = String(form?.get("password") || "");
      if (given && same(await sha256(`${share.password.salt}:${given}`), share.password.hash)) {
        return Response.redirect(`${url.origin}/v/${id}?k=${await accessKey(env, id, share)}`, 303);
      }
      return html(401, message("Wrong password", "Try again.", passwordForm(id)), security(nonce));
    }
    if (!(await allowed(env, id, share, url))) {
      return html(200, message("This video has a password", "Enter it to watch.", passwordForm(id)), security(nonce));
    }
  }

  const key = share.password ? `?k=${encodeURIComponent(url.searchParams.get("k"))}` : "";
  const file = (name) => `/v/${id}/${name}${key}`;
  const absolute = (name) => `${url.origin}${file(name)}`;
  const ready = share.status === "ready";
  const when = share.createdAt ? new Date(share.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "";
  // Link previews in Slack and iMessage, except for videos behind a password.
  const head = share.password
    ? ""
    : `<meta property="og:type" content="video.other"><meta property="og:title" content="${escape(share.title)}"><meta property="og:description" content="${escape(share.summary || `A ${clock(share.duration)} video`)}">${
        share.hasThumb ? `<meta property="og:image" content="${absolute("thumb.jpg")}"><meta name="twitter:card" content="summary_large_image">` : ""
      }${ready ? `<meta property="og:video" content="${absolute("video.mp4")}"><meta property="og:video:type" content="video/mp4"><meta property="og:video:width" content="${Number(share.width) || 1920}"><meta property="og:video:height" content="${Number(share.height) || 1080}">` : ""}`;

  const chapters = (share.chapters || [])
    .map((chapter) => `<li><button class="chapter" data-t="${Number(chapter.start) || 0}"><span class="time">${clock(chapter.start)}</span><span>${escape(chapter.title)}</span></button></li>`)
    .join("");
  const lines = (share.transcript || [])
    .map((line) => `<li><button class="line" data-t="${Number(line.start) || 0}"><span class="time">${clock(line.start)}</span><span>${escape(line.text)}</span></button></li>`)
    .join("");

  const player = ready
    ? `<video id="v" controls playsinline preload="metadata"${share.hasThumb ? ` poster="${file("thumb.jpg")}"` : ""}><source src="${file("video.mp4")}" type="video/mp4">${
        share.hasCaptions ? `<track kind="captions" src="${file("captions.vtt")}" srclang="en" label="English">` : ""
      }</video>`
    : `<div class="center" style="min-height:40vh"><p class="meta">Still uploading. This page refreshes itself.</p></div>`;

  const body = `<main>
<a class="top" href="https://ember.appliedleverage.io">${MARK}<span>Ember</span></a>
<div class="player">${player}</div>
<div class="grid"><section>
<h1>${escape(share.title)}</h1>
<p class="meta">${[when, share.duration ? clock(share.duration) : ""].filter(Boolean).join(" · ")}</p>
${share.summary ? `<p class="summary">${escape(share.summary)}</p>` : ""}
${ready && share.download ? `<div class="actions"><a class="button" href="${file("video.mp4")}${key ? "&" : "?"}download=1">Download</a></div>` : ""}
${chapters ? `<h2>Chapters</h2><ol>${chapters}</ol>` : ""}
</section>
${lines ? `<aside><h2>Transcript</h2><ol id="lines">${lines}</ol></aside>` : ""}
</div>
<footer>Recorded with <a href="https://ember.appliedleverage.io">Ember</a>.</footer>
</main>
<script nonce="${nonce}">
${ready ? "" : "setTimeout(()=>location.reload(),8000);"}
const v=document.getElementById("v");
if(v){
  document.querySelectorAll("[data-t]").forEach((b)=>b.addEventListener("click",()=>{v.currentTime=Number(b.dataset.t);v.play();}));
  const lines=[...document.querySelectorAll("#lines .line")];const marks=[...document.querySelectorAll(".chapter")];
  const mark=(list)=>{let on=-1;list.forEach((b,i)=>{if(Number(b.dataset.t)<=v.currentTime+0.2)on=i;});list.forEach((b,i)=>b.classList.toggle("on",i===on));return list[on];};
  v.addEventListener("timeupdate",()=>{mark(marks);const line=mark(lines);if(line&&!v.paused){const box=line.closest("ol");const top=line.offsetTop-box.offsetTop;if(top<box.scrollTop||top>box.scrollTop+box.clientHeight-60)box.scrollTo({top:top-40,behavior:"smooth"});}});
}
</script>`;
  return html(200, page({ title: share.title || "Video", head, body }), security(nonce));
}

function passwordForm(id) {
  return `<form method="post" action="/v/${id}"><input type="password" name="password" placeholder="Password" autofocus required><button class="button" type="submit">Watch</button></form>`;
}

// A file of a video, with byte ranges so players can seek.
async function media(request, env, id, name, url) {
  const share = await details(env, id);
  if (!share || expired(share) || !(await allowed(env, id, share, url))) return new Response("Not found", { status: 404 });
  if (name === "video.mp4" && url.searchParams.has("download") && !share.download) return new Response("Not found", { status: 404 });
  const object = await env.BUCKET.get(`${id}/${name}`, { range: request.headers, onlyIf: request.headers });
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers({
    "content-type": FILES[name],
    "accept-ranges": "bytes",
    "cache-control": share.password ? "private, no-store" : "public, max-age=3600",
    etag: object.httpEtag,
    "x-content-type-options": "nosniff",
  });
  if (url.searchParams.has("download")) headers.set("content-disposition", `attachment; filename="${String(share.title || "video").replace(/[^\w .-]+/g, "").slice(0, 80) || "video"}.mp4"`);
  if (!("body" in object) || !object.body) return new Response(null, { status: 304, headers });
  if (object.range && request.headers.has("range")) {
    const size = object.size;
    // R2 names the fields it didn't use too, so only a number counts.
    const suffix = typeof object.range.suffix === "number" ? object.range.suffix : null;
    const offset = suffix !== null ? size - suffix : Number(object.range.offset) || 0;
    const length = suffix !== null ? suffix : typeof object.range.length === "number" ? object.range.length : size - offset;
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${size}`);
    headers.set("content-length", String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("content-length", String(object.size));
  return new Response(object.body, { headers });
}

/* Ember's side */

async function api(request, env, url) {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!env.UPLOAD_SECRET || !token || !same(token, env.UPLOAD_SECRET)) return json(401, { error: "Not allowed." });
  const parts = url.pathname.split("/").filter(Boolean).slice(1);
  if (parts[0] === "health" && request.method === "GET") return json(200, { ok: true, version: VERSION });
  if (parts[0] !== "shares" || !ID.test(parts[1] || "")) return json(404, { error: "Not found." });
  const id = parts[1];

  // Multipart upload of the video, in parts of at least 5 MB.
  if (parts[2] === "uploads") {
    const key = `${id}/video.mp4`;
    if (parts.length === 3 && request.method === "POST") {
      const upload = await env.BUCKET.createMultipartUpload(key, { httpMetadata: { contentType: "video/mp4" } });
      return json(200, { uploadId: upload.uploadId });
    }
    const upload = env.BUCKET.resumeMultipartUpload(key, decodeURIComponent(parts[3] || ""));
    if (parts.length === 5 && parts[4] === "complete" && request.method === "POST") {
      const { parts: uploaded } = await request.json();
      await upload.complete(uploaded.map((part) => ({ partNumber: Number(part.partNumber), etag: String(part.etag) })));
      return json(200, { ok: true });
    }
    if (parts.length === 5 && request.method === "PUT") {
      const part = await upload.uploadPart(Number(parts[4]), request.body);
      return json(200, { partNumber: part.partNumber, etag: part.etag });
    }
    if (parts.length === 4 && request.method === "DELETE") {
      await upload.abort();
      return json(200, { ok: true });
    }
  }

  // Small files: the poster, captions, and the details (share.json).
  if (parts[2] === "files" && request.method === "PUT") {
    const name = parts[3];
    if (name === "share.json") {
      const text = await request.text();
      if (text.length > MAX_DETAILS) return json(413, { error: "Too large." });
      JSON.parse(text);
      await env.BUCKET.put(`${id}/share.json`, text, { httpMetadata: { contentType: "application/json" } });
      return json(200, { ok: true });
    }
    if (FILES[name] && name !== "video.mp4") {
      await env.BUCKET.put(`${id}/${name}`, request.body, { httpMetadata: { contentType: FILES[name] } });
      return json(200, { ok: true });
    }
  }

  if (parts.length === 2 && request.method === "DELETE") {
    const listed = await env.BUCKET.list({ prefix: `${id}/` });
    if (listed.objects.length) await env.BUCKET.delete(listed.objects.map((object) => object.key));
    return json(200, { ok: true });
  }
  return json(404, { error: "Not found." });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) return await api(request, env, url);
      const match = /^\/v\/([A-Za-z0-9]+)(?:\/([\w.]+))?\/?$/.exec(url.pathname);
      if (match && ID.test(match[1])) {
        if (!match[2] && (request.method === "GET" || request.method === "POST")) return await viewer(request, env, match[1], url);
        if (match[2] && FILES[match[2]] && (request.method === "GET" || request.method === "HEAD")) return await media(request, env, match[1], match[2], url);
      }
      if (url.pathname === "/" || url.pathname === "") return html(200, message("Ember", "Videos shared from Ember live here. You need a link to see one."));
      return html(404, message("Not found", "This link doesn't go anywhere."));
    } catch (error) {
      return url.pathname.startsWith("/api/") ? json(500, { error: String(error?.message || error) }) : html(500, message("Something went wrong", "Try again in a moment."));
    }
  },
};

export { VERSION };
