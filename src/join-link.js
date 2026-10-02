// Turns a calendar's call link into the best way to join: Zoom links open the Zoom app straight
// into the meeting; other links open as they are (Meet in the browser, Teams in its app or browser).

function joinTarget(link) {
  let url;
  try {
    url = new URL(String(link || ""));
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  if (host === "zoom.us" || host.endsWith(".zoom.us")) {
    const id = /^\/(?:j|w|s)\/(\d{9,12})/.exec(url.pathname)?.[1];
    if (id) {
      const params = new URLSearchParams({ action: "join", confno: id });
      const password = url.searchParams.get("pwd");
      if (password) params.set("pwd", password);
      return { url: `zoommtg://zoom.us/join?${params}`, label: "Open Zoom & join", app: "Zoom" };
    }
    return { url: url.href, label: "Open Zoom & join", app: "Zoom" };
  }
  if (host === "meet.google.com") return { url: url.href, label: "Join Google Meet", app: "Google Meet" };
  if (host.endsWith("teams.microsoft.com") || host.endsWith("teams.live.com")) return { url: url.href, label: "Open Teams & join", app: "Microsoft Teams" };
  return { url: url.href, label: "Join call", app: null };
}

module.exports = { joinTarget };
