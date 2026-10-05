"""Uploads a folder to a Cloudflare Pages project's asset store (the Direct Upload flow wrangler uses),
getting the upload token through Composio. Writes the deployment manifest to manifest.json."""
import base64, json, mimetypes, os, subprocess, sys, urllib.request
from blake3 import blake3

ACC, PROJECT, ROOT, OUT = sys.argv[1:5]
SKIP = {"brag-output", "scripts", "README.md", ".gitignore", ".DS_Store"}

def proxy(path, method="GET", body=None):
    cmd = ["composio", "proxy", f"https://api.cloudflare.com/client/v4/accounts/{ACC}/pages/projects/{PROJECT}/{path}", "--toolkit", "cloudflare", "-X", method]
    if body is not None: cmd += ["-H", "content-type: application/json", "-d", json.dumps(body)]
    d = json.loads(subprocess.check_output(cmd, stdin=subprocess.DEVNULL, timeout=60)); return d.get("data", d)

jwt = proxy("upload-token")["result"]["jwt"]

def api(path, body):
    req = urllib.request.Request(f"https://api.cloudflare.com/client/v4/pages/assets/{path}", data=json.dumps(body).encode(), method="POST",
                                 headers={"Authorization": f"Bearer {jwt}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r: return json.load(r)

files = {}
for dirpath, dirnames, names in os.walk(ROOT):
    dirnames[:] = [d for d in dirnames if d not in SKIP]
    for n in names:
        if n in SKIP: continue
        full = os.path.join(dirpath, n); rel = "/" + os.path.relpath(full, ROOT).replace(os.sep, "/")
        data = open(full, "rb").read(); b64 = base64.b64encode(data).decode()
        ext = os.path.splitext(n)[1][1:]
        h = blake3((b64 + ext).encode()).hexdigest()[:32]
        files[rel] = {"hash": h, "b64": b64, "type": mimetypes.guess_type(n)[0] or "application/octet-stream", "size": len(data)}

hashes = sorted({f["hash"] for f in files.values()})
missing = set(api("check-missing", {"hashes": hashes})["result"])
bucket, size = [], 0
def flush():
    global bucket, size
    if bucket: api("upload", bucket)
    bucket, size = [], 0
for rel, f in files.items():
    if f["hash"] not in missing: continue
    missing.discard(f["hash"])
    if size + len(f["b64"]) > 40_000_000: flush()
    bucket.append({"key": f["hash"], "value": f["b64"], "metadata": {"contentType": f["type"]}, "base64": True}); size += len(f["b64"])
flush()
api("upsert-hashes", {"hashes": hashes})
json.dump({rel: f["hash"] for rel, f in files.items()}, open(OUT, "w"), indent=1)
print(f"{len(files)} files, {sum(f['size'] for f in files.values()) // 1024} KB, uploaded and registered")
