#!/bin/zsh
# Creates the "Call Transcripts" Notion database that Meeting Notes saves calls into.
# Usage: scripts/create-notion-database.sh <parent-page-id>
set -euo pipefail

if (( $# != 1 )); then
  print -u2 "Usage: $0 <parent-page-id>"
  print -u2 "The parent page must be shared with the Notion CLI (run 'ntn login' first)."
  exit 1
fi
command -v ntn >/dev/null 2>&1 || { print -u2 "Install the Notion CLI first: brew install notion-cli && ntn login"; exit 1; }

parent_id="$1"
request=$(cat <<JSON
{
  "parent": { "type": "page_id", "page_id": "${parent_id}" },
  "icon": { "type": "emoji", "emoji": "🎙️" },
  "title": [{ "type": "text", "text": { "content": "Call Transcripts" } }],
  "description": [{ "type": "text", "text": { "content": "Saved automatically by the Meeting Notes app after each recorded call." } }],
  "initial_data_source": {
    "properties": {
      "Name": { "title": {} },
      "Date": { "date": {} },
      "Duration (min)": { "number": { "format": "number" } },
      "Source": { "select": { "options": [ { "name": "Manual", "color": "gray" }, { "name": "Zoom auto", "color": "blue" } ] } },
      "Action items": { "number": { "format": "number" } },
      "Transcription": { "select": {} },
      "Summary model": { "rich_text": {} },
      "Local note": { "rich_text": {} }
    }
  }
}
JSON
)

# ntn waits on an open stdin, so feed the request through it and close it.
response=$(print -r -- "$request" | ntn api v1/databases -X POST -d @-)
print -r -- "$response" | /usr/bin/python3 -c '
import json, sys
d = json.load(sys.stdin)
if d.get("object") == "error":
    sys.exit("Notion error: " + d.get("message", d.get("code", "unknown")))
print("Created:        " + d["url"])
print("Data source ID: " + d["data_sources"][0]["id"])
print("Paste the data source ID into Meeting Notes → Settings → Notion.")
'
