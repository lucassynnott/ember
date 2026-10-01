---
version: 1
slug: "renderer-index-html"
primary_target: "renderer/index.html"
related_targets: ["renderer/settings.html","renderer/dictation.html"]
---

# Surface brief: Meeting Notes desktop windows

Scope: the main live-notes window (primary), Settings window, and the dictation pill. Mode: Operate.
Audience and job: the owner and new users, glancing at the app beside Zoom during a call; setting it up once; dictating anywhere.
Constraints: dark only, shadcn/ui components only (Vite + React + Tailwind), notes beside transcript, quiet during calls, Settings as a proper settings window, no em dashes in copy.
Approved comp: .impeccable/mocks/comp-1.png (off-centre rail). Comp 3 (.impeccable/mocks/comp-3.png) informs the after-call state, minus its yellow overuse.

## Direction contract

THESIS: The call hangs off one calibrated rail and state is line form, not colour. It refuses the AI meeting dashboard: no cards, no avatars, no chat panel, no gradient.

OWN-WORLD: Charcoal continuum ground (#16181B to #1E2024), bone ink (#E8E4DA), muted ash secondary, hairline rules. One grotesque (SF Pro system face) ranked by weight and tracking. Sodium yellow appears only as the doubled tick for the person speaking now; red only for REC and Stop. Past lines are solid hairline ticks, pending is dashed, finished is a terminal mark.

STORY: During a call the user glances over, sees who is speaking and the latest line on the rail, and the notes column keeps the summary, decision and actions current. After the call the notes take over at reading size and a quiet line confirms where they were saved.

FIRST VIEWPORT: Title bar with meeting title left, REC and timer right of centre-right, Stop at the far right. Left column about 25 percent: Notes label, Summary, Decision, Actions, then Participants with state ticks. A hairline divides it from the rail at about 38 percent, timecodes to the rail's left, transcript lines hanging to its right with speaker names in weight. Dashed pending tick with Listening for more speech. Footer status line: model, Zoom, settings control.

FORM: Emission-line rail (operate-c-emission-line-rail), dealt challenger chosen by the user in re-roll round 1; seed key 79d40e37. Signature interaction: a new transcript line lands on the rail and the doubled yellow tick moves to the current speaker.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
