const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

// An existing install wins; otherwise use the copy Meeting Notes downloaded for you.
const NTN_CANDIDATES = [
  "/opt/homebrew/bin/ntn",
  "/usr/local/bin/ntn",
  path.join(os.homedir(), "Library", "Application Support", "MeetingNotes", "bin", "ntn"),
];

async function findNtnBinary() {
  for (const candidate of [process.env.NTN_BIN, ...NTN_CANDIDATES].filter(Boolean)) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function isoWithOffset(date) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const hours = pad(Math.floor(Math.abs(offset) / 60));
  const minutes = pad(Math.abs(offset) % 60);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${hours}:${minutes}`
  );
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function meetingTitle(startedAt) {
  const day = `${WEEKDAYS[startedAt.getDay()]} ${startedAt.getDate()} ${MONTHS[startedAt.getMonth()]} ${startedAt.getFullYear()}`;
  return `Meeting — ${day}, ${pad(startedAt.getHours())}:${pad(startedAt.getMinutes())}`;
}

function escapeLine(text) {
  return text.replace(/^(\s*)([#>*+-]|\d+[.)])(\s)/, "$1\\$2$3").replace(/</g, "&lt;");
}

function bullets(items, emptyLabel = "None captured.") {
  return items?.length ? items.map((item) => `- ${escapeLine(item)}`).join("\n") : `- ${emptyLabel}`;
}

function transcriptParagraphs(transcript) {
  const lines = transcript
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return "_No speech was transcribed._";
  return lines
    .map((line) => {
      const match = line.match(/^([^:\n]{1,60}):\s+(.*)$/);
      return match ? `**${escapeLine(match[1])}:** ${escapeLine(match[2])}` : escapeLine(line);
    })
    .join("\n\n");
}

function formatNotionMarkdown({ transcript, analysis, notePath, audioPath }) {
  const actions = analysis.actionItems?.length
    ? analysis.actionItems
        .map(({ owner, task }) => `- [ ] **${escapeLine(owner || "Unassigned")}** — ${escapeLine(task)}`)
        .join("\n")
    : "- None captured.";
  const yourNotes = analysis.yourNotes?.length
    ? [
        "## Your notes",
        "",
        analysis.yourNotes
          .map(({ note, detail }) => (detail ? `- **${escapeLine(note)}** — ${escapeLine(detail)}` : `- **${escapeLine(note)}**`))
          .join("\n"),
        "",
      ]
    : [];
  return [
    ...yourNotes,
    "## Summary",
    "",
    bullets(analysis.summary),
    "",
    "## Decisions made",
    "",
    bullets(analysis.decisions),
    "",
    "## Action items",
    "",
    actions,
    "",
    "---",
    "",
    "## Full transcript",
    "",
    transcriptParagraphs(transcript || ""),
    "",
    "---",
    "",
    `Local note: \`${notePath}\``,
    "",
    `Audio: \`${audioPath}\``,
    "",
  ].join("\n");
}

function richText(content) {
  return [{ type: "text", text: { content: String(content).slice(0, 2000) } }];
}

function buildPageRequest({
  dataSourceId,
  startedAt,
  endedAt,
  origin,
  callApp,
  transcript,
  analysis,
  notePath,
  audioPath,
}) {
  const properties = {
    Name: { title: richText(analysis.title || meetingTitle(startedAt)) },
    Date: { date: { start: isoWithOffset(startedAt), end: isoWithOffset(endedAt) } },
    "Duration (min)": {
      number: Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 6000) / 10),
    },
    Source: { select: { name: origin === "zoom-auto" ? `${callApp || "Zoom"} auto` : "Manual" } },
    "Action items": { number: analysis.actionItems?.length || 0 },
    "Local note": { rich_text: richText(notePath.replace(os.homedir(), "~")) },
  };
  if (analysis.transcriptionProvider) {
    properties.Transcription = { select: { name: String(analysis.transcriptionProvider).replace(/,/g, " ").slice(0, 100) } };
  }
  if (analysis.summaryProvider) {
    properties["Summary model"] = { rich_text: richText(analysis.summaryProvider) };
  }
  return {
    parent: { type: "data_source_id", data_source_id: dataSourceId },
    icon: { type: "emoji", emoji: origin === "zoom-auto" ? "📹" : "🎙️" },
    properties,
    markdown: formatNotionMarkdown({
      transcript,
      analysis,
      notePath: notePath.replace(os.homedir(), "~"),
      audioPath: audioPath.replace(os.homedir(), "~"),
    }),
  };
}

function runNtn(binaryPath, args, input, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    // ntn waits for stdin when it is an open pipe, so always write and close it.
    const child = spawn(binaryPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Notion CLI timed out."));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      let response = null;
      try {
        response = JSON.parse(stdout);
      } catch {}
      if (response?.object === "error") {
        reject(new Error(`Notion: ${response.message || response.code}`));
      } else if (code !== 0 || !response) {
        reject(new Error(`Notion CLI exited with code ${code}: ${(stderr || stdout).trim().slice(0, 500)}`));
      } else {
        resolve(response);
      }
    });
    child.stdin.end(input ?? "");
  });
}

class NotionSync {
  constructor({ ledgerPath, getSettings, request }) {
    this.ledgerPath = ledgerPath;
    this.getSettings = getSettings;
    // Sends one Notion API call; main wires this to the Notion CLI or Composio, whichever is signed in.
    this.request = request || NotionSync.viaNtn;
    this.chain = Promise.resolve();
  }

  async #readLedger() {
    try {
      const ledger = JSON.parse(await fs.readFile(this.ledgerPath, "utf8"));
      return { synced: ledger.synced || {}, pending: ledger.pending || {} };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { synced: {}, pending: {} };
    }
  }

  async #writeLedger(ledger) {
    await fs.mkdir(path.dirname(this.ledgerPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.ledgerPath}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryPath, this.ledgerPath);
  }

  #serialize(task) {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => {});
    return run;
  }

  enabled() {
    const settings = this.getSettings();
    return Boolean(settings.notionSyncEnabled && settings.notionDataSourceId);
  }

  static async viaNtn(method, apiPath, body) {
    const binaryPath = await findNtnBinary();
    if (!binaryPath) throw new Error("The Notion CLI (ntn) is not installed.");
    return runNtn(binaryPath, ["api", apiPath, "-X", method, "-d", "@-"], JSON.stringify(body));
  }

  async #send(request) {
    const page = await this.request("POST", "v1/pages", request);
    return { id: page.id, url: page.url };
  }

  // Saves one meeting. Failures are queued in the ledger and retried later.
  saveMeeting(meeting) {
    return this.#serialize(async () => {
      if (!this.enabled()) return { skipped: true };
      const ledger = await this.#readLedger();
      if (ledger.synced[meeting.notePath]) return { ...ledger.synced[meeting.notePath], duplicate: true };
      const request = buildPageRequest({ ...meeting, dataSourceId: this.getSettings().notionDataSourceId });
      try {
        const page = await this.#send(request);
        ledger.synced[meeting.notePath] = { ...page, syncedAt: new Date().toISOString() };
        delete ledger.pending[meeting.notePath];
        await this.#writeLedger(ledger);
        return page;
      } catch (error) {
        ledger.pending[meeting.notePath] = {
          request,
          error: error.message,
          failedAt: new Date().toISOString(),
        };
        await this.#writeLedger(ledger);
        throw error;
      }
    });
  }

  retryPending() {
    return this.#serialize(async () => {
      if (!this.enabled()) return { saved: [], failed: [] };
      const ledger = await this.#readLedger();
      const saved = [];
      const failed = [];
      for (const [notePath, entry] of Object.entries(ledger.pending)) {
        if (ledger.synced[notePath]) {
          delete ledger.pending[notePath];
          continue;
        }
        const request = {
          ...entry.request,
          parent: { type: "data_source_id", data_source_id: this.getSettings().notionDataSourceId },
        };
        try {
          const page = await this.#send(request);
          ledger.synced[notePath] = { ...page, syncedAt: new Date().toISOString() };
          delete ledger.pending[notePath];
          saved.push({ notePath, ...page });
        } catch (error) {
          entry.error = error.message;
          entry.failedAt = new Date().toISOString();
          failed.push({ notePath, error: error.message });
        }
        await this.#writeLedger(ledger);
      }
      return { saved, failed };
    });
  }
}

module.exports = {
  NotionSync,
  buildPageRequest,
  findNtnBinary,
  formatNotionMarkdown,
  meetingTitle,
  runNtn,
};
