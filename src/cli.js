// The ember command: search and read your calls from Terminal, and run the MCP server
// for AI apps. Read only, like the MCP server it shares its tools with.
const { MeetingNotesTools, serve } = require("./mcp-server");

const HELP = `ember: your calls and knowledge base from the command line

Usage:
  ember search <words…> [--limit N]      Calls that mention something
  ember list [--from DATE] [--to DATE] [--folder NAME] [--tag TAG] [--limit N]
  ember show <id> [--no-transcript]      One call's notes and transcript
  ember actions [--owner NAME] [--from DATE] [--to DATE] [--all]
  ember kb <words…> [--limit N]          Search your knowledge base
  ember transcribe <file…> [--format F] [--out FILE | --out-dir DIR]
                                         Transcribe video or audio files on this Mac,
                                         every word timed. F: json (default), words,
                                         srt, vtt or txt. One file prints unless --out;
                                         several are saved beside each video, or in DIR.
  ember mcp                              Run the MCP server on stdio
  ember --version

Dates are YYYY-MM-DD. Ids look like 2026-10-01-1605 and come from search and list.`;

function parse(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split("=", 2);
    if (inline !== undefined) flags[key] = inline;
    else if (argv[index + 1] && !argv[index + 1].startsWith("--") && !["all", "no-transcript", "help", "version"].includes(key)) flags[key] = argv[++index];
    else flags[key] = true;
  }
  return { positional, flags };
}

/**
 * Transcribes files with every word timed; progress goes to stderr so stdout stays clean for piping. One file prints
 * (or goes to --out); several are each saved beside the video, or in --out-dir, with Parakeet loaded once for all.
 */
async function transcribe(positional, flags, out) {
  const fs = require("node:fs");
  const path = require("node:path");
  const { FORMATS, formatTranscript, helperPaths, transcribeMedia } = require("./media-transcribe");
  const { LiveParakeetTranscriber } = require("./live-transcription");
  const { MODELS_DIR } = require("./model-manager");
  const { findParakeet } = require("./word-timing");
  // Paths with spaces typed without quotes arrive in pieces; several real files are a batch.
  const joined = positional.join(" ");
  const files = positional.length > 1 && !fs.existsSync(joined) ? positional : positional.length ? [joined] : [];
  if (!files.length) throw new Error("Which file? e.g. ember transcribe ~/Movies/demo.mp4 --format json");
  const format = typeof flags.format === "string" ? flags.format : "json";
  if (!FORMATS[format]) throw new Error(`Unknown format “${format}”. Use ${Object.keys(FORMATS).join(", ")}.`);
  if (files.length > 1 && typeof flags.out === "string") throw new Error("--out is for one file. For several, use --out-dir FOLDER, or leave it out to save each beside its video.");
  const outDir = typeof flags["out-dir"] === "string" ? flags["out-dir"] : null;
  if (outDir) fs.mkdirSync(outDir, { recursive: true });
  const modelPath = findParakeet(MODELS_DIR);
  if (!modelPath) throw new Error("Parakeet isn't on this Mac yet. Open Ember, then Settings → Transcription, and download Parakeet v3.");
  const helpers = helperPaths();
  const transcriber = new LiveParakeetTranscriber({ binaryPath: helpers.parakeet, modelPath });
  const tty = process.stderr.isTTY;
  const batch = files.length > 1 || outDir;
  let failures = 0;
  try {
    await transcriber.start();
    for (const [index, file] of files.entries()) {
      const label = files.length > 1 ? `[${index + 1}/${files.length}] ${path.basename(file)}: ` : "";
      const started = Date.now();
      try {
        const result = await transcribeMedia(file, {
          helpers,
          transcriber,
          onProgress: (value) => tty && process.stderr.write(`\r\x1b[K${label}Transcribing… ${Math.round(value * 100)}%`),
        });
        if (tty) process.stderr.write("\r\x1b[K");
        const text = formatTranscript(result, format);
        const words = result.segments.reduce((sum, segment) => sum + segment.words.length, 0);
        const seconds = (Date.now() - started) / 1000;
        const note = `${words} words from ${Math.round(result.duration)} s of sound in ${seconds.toFixed(1)} s (${Math.round(result.duration / Math.max(seconds, 0.1))}× real time)`;
        const target = typeof flags.out === "string" ? flags.out : batch ? path.join(outDir || path.dirname(path.resolve(file)), `${path.basename(file).replace(/\.[^.]+$/, "")}.${FORMATS[format].ext}`) : null;
        if (target) {
          fs.writeFileSync(target, text, "utf8");
          process.stderr.write(`${label}Saved ${target}: ${note}\n`);
        } else {
          out(text.replace(/\n$/, ""));
          if (tty) process.stderr.write(`${note}\n`);
        }
      } catch (error) {
        if (files.length === 1) throw error;
        failures += 1;
        if (tty) process.stderr.write("\r\x1b[K");
        process.stderr.write(`${label}${error.message}\n`);
      }
    }
  } finally {
    await transcriber.stop().catch(() => {});
  }
  if (failures) throw new Error(`${failures} of ${files.length} files couldn't be transcribed.`);
}

const number = (value) => (value === undefined ? undefined : Number(value));

async function run(argv, { tools, out = (text) => process.stdout.write(`${text}\n`) } = {}) {
  const [command, ...rest] = argv;
  const { positional, flags } = parse(rest);
  if (!command || command === "help" || command === "--help" || command === "-h") return out(HELP);
  if (command === "--version" || command === "version") return out(require("../package.json").version);
  if (command === "mcp") {
    console.log = console.error;
    serve();
    return new Promise(() => {});
  }
  tools ||= new MeetingNotesTools();
  const query = positional.join(" ");
  switch (command) {
    case "search":
      return out(await tools.search_meetings({ query, limit: number(flags.limit) }));
    case "list":
      return out(await tools.list_meetings({ from: flags.from, to: flags.to, folder: flags.folder, tag: flags.tag, limit: number(flags.limit) }));
    case "show":
      if (!positional[0]) throw new Error("Which call? Give its id, e.g. meeting-notes show 2026-10-01-1605");
      return out(await tools.get_meeting({ id: positional[0], include_transcript: !flags["no-transcript"] }));
    case "actions":
      return out(await tools.get_action_items({ owner: flags.owner, from: flags.from, to: flags.to, open_only: !flags.all }));
    case "kb":
      return out(await tools.search_knowledge({ query, limit: number(flags.limit) }));
    case "transcribe":
      return transcribe(positional, flags, out);
    default:
      throw new Error(`Unknown command “${command}”. Try meeting-notes --help`);
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`meeting-notes: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = { parse, run };
