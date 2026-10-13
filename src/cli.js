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
  ember transcribe <file> [--format F] [--out FILE]
                                         Transcribe a video or audio file on this Mac,
                                         every word timed. F: json (default), words,
                                         srt, vtt or txt. Without --out it prints.
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

/** Transcribes a file with every word timed; progress goes to stderr so stdout stays clean for piping. */
async function transcribe(file, flags, out) {
  const fs = require("node:fs/promises");
  const { FORMATS, formatTranscript, transcribeMedia } = require("./media-transcribe");
  if (!file) throw new Error("Which file? e.g. ember transcribe ~/Movies/demo.mp4 --format json");
  const format = typeof flags.format === "string" ? flags.format : "json";
  if (!FORMATS[format]) throw new Error(`Unknown format “${format}”. Use ${Object.keys(FORMATS).join(", ")}.`);
  const started = Date.now();
  const tty = process.stderr.isTTY;
  const result = await transcribeMedia(file, {
    onProgress: (value) => tty && process.stderr.write(`\rTranscribing… ${Math.round(value * 100)}%`),
  });
  if (tty) process.stderr.write("\r\x1b[K");
  const text = formatTranscript(result, format);
  const words = result.segments.reduce((sum, segment) => sum + segment.words.length, 0);
  const seconds = (Date.now() - started) / 1000;
  const note = `${words} words from ${Math.round(result.duration)} s of sound in ${seconds.toFixed(1)} s (${Math.round(result.duration / Math.max(seconds, 0.1))}× real time)`;
  if (typeof flags.out === "string") {
    await fs.writeFile(flags.out, text, "utf8");
    process.stderr.write(`Saved ${flags.out}: ${note}\n`);
    return;
  }
  out(text.replace(/\n$/, ""));
  if (tty) process.stderr.write(`${note}\n`);
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
      return transcribe(positional.join(" "), flags, out);
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
