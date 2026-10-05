// Reads a saved link: its title, author, site, preview image and readable text. Posts on X and
// TikTok come from their public embed endpoints, since their pages need a login to show the post.
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_TEXT = 20000;
const TIMEOUT_MS = 15000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

function decodeEntities(text) {
  return String(text || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === "#") {
      const value = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

function clean(text, max = 500) {
  return decodeEntities(text).replace(/\s+/g, " ").trim().slice(0, max);
}

// Accepts "example.com/x" as well as full links; only web pages.
function normalizeUrl(input) {
  const raw = String(input || "").trim();
  if (!raw || /\s/.test(raw)) return null;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname.includes(".")) return null;
  url.hash = "";
  // Tracking parameters make the same page look different.
  for (const key of [...url.searchParams.keys()]) {
    const xShare = /^(s|t)$/i.test(key) && /(^|\.)(x|twitter)\.com$/.test(url.hostname);
    if (/^(utm_|fbclid$|gclid$|igshid$|mc_|ref_src$)/i.test(key) || xShare) url.searchParams.delete(key);
  }
  return url.toString();
}

// The first link in some text, e.g. what's on the clipboard.
function findUrl(text) {
  const match = String(text || "").match(/\bhttps?:\/\/[^\s<>"'`]+/i) || String(text || "").trim().match(/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\/?\S*$/i);
  return match ? normalizeUrl(match[0].replace(/[).,;:!?]+$/, "")) : null;
}

function kindFor(url, type = "") {
  const host = new URL(url).hostname.replace(/^www\./, "");
  if (/(^|\.)(x|twitter|threads|bsky|linkedin|instagram|tiktok|facebook|reddit|mastodon\.social)\.(com|net|app|social)$|^bsky\.app$|^threads\.net$/.test(host)) return "post";
  if (/(^|\.)(youtube\.com|youtu\.be|vimeo\.com|loom\.com)$/.test(host) || /video/.test(type)) return "video";
  if (/article|blog|news/.test(type)) return "article";
  return "link";
}

function metaTags(html) {
  const tags = {};
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const name = (tag.match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const content = (tag.match(/\bcontent\s*=\s*"([^"]*)"/i) || tag.match(/\bcontent\s*=\s*'([^']*)'/i) || [])[1];
    if (name && content !== undefined && !(name.toLowerCase() in tags)) tags[name.toLowerCase()] = content;
  }
  return tags;
}

// The page's main text: the article or main element if there is one, without scripts, menus and footers.
function readableText(html) {
  const body = (html.match(/<article\b[\s\S]*?<\/article>/i) || html.match(/<main\b[\s\S]*?<\/main>/i) || html.match(/<body\b[\s\S]*<\/body>/i) || [html])[0];
  const text = body
    .replace(/<(script|style|noscript|svg|nav|footer|header|aside|form|iframe|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/blockquote)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(text)
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .filter((line) => line.length > 1)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .slice(0, MAX_TEXT);
}

function absolute(link, base) {
  if (!link) return "";
  try {
    const url = new URL(decodeEntities(link), base);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

// Everything a card needs, from a page's HTML.
function parsePage(html, url) {
  const meta = metaTags(html);
  const title = clean(meta["og:title"] || meta["twitter:title"] || (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "", 300);
  const canonical = absolute((html.match(/<link\b[^>]*rel=["']canonical["'][^>]*>/i)?.[0].match(/href=["']([^"']+)["']/i) || [])[1], url);
  const text = readableText(html);
  const description = clean(meta["og:description"] || meta["twitter:description"] || meta.description || "", 600);
  return {
    url,
    canonicalUrl: normalizeUrl(canonical) || url,
    title,
    description,
    siteName: clean(meta["og:site_name"] || meta["application-name"] || new URL(url).hostname.replace(/^www\./, ""), 80),
    author: clean(meta.author || meta["article:author"] || meta["twitter:creator"] || meta["og:article:author"] || "", 120),
    image: absolute(meta["og:image:secure_url"] || meta["og:image"] || meta["twitter:image"] || meta["twitter:image:src"], url),
    publishedAt: Date.parse(meta["article:published_time"] || meta["og:article:published_time"] || "") || null,
    kind: kindFor(url, meta["og:type"] || ""),
    // Pages that render with JavaScript (YouTube) leave only menus in the HTML; their description says more.
    text: text.length < 400 && description.length > text.length / 2 ? description : text || description,
  };
}

async function fetchLimited(url, { fetchImpl = fetch, accept = "text/html,application/xhtml+xml,*/*;q=0.8", signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const response = await fetchImpl(url, { redirect: "follow", signal: controller.signal, headers: { "User-Agent": USER_AGENT, Accept: accept, "Accept-Language": "en" } });
    if (!response.ok) throw new Error(`The page answered ${response.status}.`);
    const reader = response.body?.getReader?.();
    if (!reader) return { response, body: Buffer.from(await response.arrayBuffer()).subarray(0, MAX_BYTES) };
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      size += value.length;
      if (size >= MAX_BYTES) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    return { response, body: Buffer.concat(chunks).subarray(0, MAX_BYTES) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// X and TikTok posts, read from their public embed endpoints.
async function fromEmbed(url, fetchImpl) {
  const host = new URL(url).hostname.replace(/^(www|mobile)\./, "");
  let endpoint = null;
  if (/^(x|twitter)\.com$/.test(host) && /\/status\/\d+/.test(url)) endpoint = `https://publish.twitter.com/oembed?omit_script=1&url=${encodeURIComponent(url.replace("://x.com", "://twitter.com"))}`;
  if (/(^|\.)tiktok\.com$/.test(host) && /\/video\/\d+/.test(url)) endpoint = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
  if (!endpoint) return null;
  const { body } = await fetchLimited(endpoint, { fetchImpl, accept: "application/json" });
  const data = JSON.parse(body.toString("utf8"));
  const quoted = String(data.html || "").match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] || "";
  const text = clean(quoted.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " "), 4000) || clean(data.title || "", 4000);
  const author = clean(data.author_name || "", 120);
  return {
    url,
    canonicalUrl: url,
    title: author ? `${author} on ${/tiktok/.test(host) ? "TikTok" : "X"}` : clean(data.title || "", 300),
    description: text.slice(0, 600),
    siteName: /tiktok/.test(host) ? "TikTok" : "X",
    author,
    image: absolute(data.thumbnail_url, url),
    publishedAt: null,
    kind: /tiktok/.test(host) ? "video" : "post",
    text,
  };
}

async function readPage(input, { fetchImpl = fetch, signal } = {}) {
  const url = normalizeUrl(input);
  if (!url) throw new Error("That isn't a web link.");
  const embedded = await fromEmbed(url, fetchImpl).catch(() => null);
  if (embedded?.text) return embedded;
  const { response, body } = await fetchLimited(url, { fetchImpl, signal });
  const finalUrl = normalizeUrl(response.url) || url;
  const type = response.headers.get("content-type") || "";
  if (/^image\//.test(type)) return { url: finalUrl, canonicalUrl: finalUrl, title: decodeURIComponent(new URL(finalUrl).pathname.split("/").pop() || "Image"), description: "", siteName: new URL(finalUrl).hostname.replace(/^www\./, ""), author: "", image: finalUrl, publishedAt: null, kind: "link", text: "" };
  if (!/html|xml|text\/plain/.test(type) && type) throw new Error("That link isn't a web page.");
  const charset = (type.match(/charset=([\w-]+)/i) || [])[1] || "utf-8";
  let html;
  try {
    html = new TextDecoder(charset).decode(body);
  } catch {
    html = body.toString("utf8");
  }
  return parsePage(html, finalUrl);
}

// The preview image, small enough to keep on this Mac.
async function readImage(url, { fetchImpl = fetch } = {}) {
  if (!url) return null;
  const { response, body } = await fetchLimited(url, { fetchImpl, accept: "image/*" });
  const type = response.headers.get("content-type") || "";
  if (!/^image\/(png|jpe?g|webp|gif)/.test(type)) return null;
  return body;
}

module.exports = { decodeEntities, findUrl, kindFor, normalizeUrl, parsePage, readImage, readPage, readableText };
