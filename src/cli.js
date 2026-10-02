// The meeting-notes command: search and read your calls from Terminal, and run the MCP server
// for AI apps. Read only, like the MCP server it shares its tools with.
const { MeetingNotesTools, serve } = require("./mcp-server");

const HELP = `meeting-notes: your calls and knowledge base from the command line

Usage:
  meeting-notes search <words…> [--limit N]      Calls that mention something
  meeting-notes list [--from DATE] [--to DATE] [--folder NAME] [--tag TAG] [--limit N]
  meeting-notes show <id> [--no-transcript]      One call's notes and transcript
  meeting-notes actions [--owner NAME] [--from DATE] [--to DATE] [--all]
  meeting-notes kb <words…> [--limit N]          Search your knowledge base
  meeting-notes mcp                              Run the MCP server on stdio
  meeting-notes --version

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
