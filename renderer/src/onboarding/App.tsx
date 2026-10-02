import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { BatteryFullIcon, Search01Icon, Tick02Icon, Wifi01Icon } from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Kbd } from "@/components/ui/kbd"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import { CalendarField, DESTINATION_HELP, MicrophoneTest, ModelRow, NotionPanel, cleanError, type Save } from "@/settings/App"
import { SPEAKER_PALETTE } from "@/lib/speaker-colors"
import { useBridgeEvents } from "@/settings/events"
import type {
  DictationStatus,
  ModelListState,
  ModelProgress,
  NotesDestination,
  OnboardingPermissions,
  PracticeResult,
  SettingsState,
} from "@/types/bridge"

const STEPS = [
  { id: "welcome", label: "Welcome" },
  { id: "you", label: "Your name" },
  { id: "permissions", label: "Permissions" },
  { id: "model", label: "Transcription" },
  { id: "notes", label: "AI notes" },
  { id: "destination", label: "Where notes go" },
  { id: "calls", label: "Your calls" },
  { id: "dictation", label: "Dictation" },
  { id: "practice", label: "Practice" },
  { id: "done", label: "Ready" },
] as const
type StepId = (typeof STEPS)[number]["id"]

const STEP_KEY = "onboarding-step"

// Saved by id, so adding a step in an update doesn't move someone who's partway through.
function readStep() {
  try {
    const saved = window.localStorage.getItem(STEP_KEY) || ""
    const index = STEPS.findIndex((step) => step.id === saved)
    return index > 0 ? index : 0
  } catch {
    return 0
  }
}

/* The step rail: the app's own line language. Done is a solid tick, the current step a doubled tick,
   steps ahead are dashed. */

function StepRail({ current, reached, onSelect }: { current: number; reached: number; onSelect: (index: number) => void }) {
  return (
    <ol className="flex flex-col" aria-label="Setup steps">
      {STEPS.map((step, index) => {
        const done = index < current
        const active = index === current
        const reachable = index <= reached && !active
        return (
          <li key={step.id} className="relative grid h-11 grid-cols-[30px_1fr] items-center">
            <span
              aria-hidden
              className={cn("absolute top-0 bottom-0 left-0 w-px", index < current ? "bg-foreground/45" : "onb-dash-y")}
            />
            <span aria-hidden className="relative block h-[7px]">
              {active ? (
                <>
                  <span className="absolute top-0 left-0 block h-[2px] w-[22px] bg-foreground" />
                  <span className="absolute top-[5px] left-0 block h-[2px] w-[22px] bg-foreground" />
                </>
              ) : done ? (
                <span className="absolute top-[3px] left-0 block h-px w-[22px] bg-foreground/75" />
              ) : (
                <span className="onb-dash-x absolute top-[3px] left-0 block h-px w-[22px]" />
              )}
            </span>
            <button
              type="button"
              disabled={!reachable}
              onClick={() => onSelect(index)}
              aria-current={active ? "step" : undefined}
              className={cn(
                "no-drag justify-self-start rounded-md px-1.5 py-1 text-left text-[13px] transition-colors",
                active && "font-semibold text-foreground",
                done && "text-foreground/80 hover:text-foreground",
                !active && !done && (reachable ? "text-muted-foreground hover:text-foreground" : "text-faint"),
              )}
            >
              {step.label}
            </button>
          </li>
        )
      })}
      <li aria-hidden className="relative h-6">
        <span className={cn("absolute top-0 left-0 h-full w-px", current === STEPS.length - 1 ? "bg-foreground/45" : "onb-dash-y")} />
      </li>
      <li aria-hidden className="relative">
        <span className={cn("block size-[7px] -translate-x-[3px]", current === STEPS.length - 1 ? "bg-foreground/70" : "border border-rail/60")} />
      </li>
    </ol>
  )
}

function StepHeader({ eyebrow, title, children }: { eyebrow?: string; title: ReactNode; children?: ReactNode }) {
  return (
    <header className="flex flex-col gap-3 pb-8">
      {eyebrow ? <p className="text-[12px] font-medium tracking-[0.02em] text-faint uppercase">{eyebrow}</p> : null}
      <h1 className="text-[28px] leading-[1.15] font-semibold tracking-[-0.025em] text-balance">{title}</h1>
      {children ? <p className="max-w-[54ch] text-[15px] leading-[1.5] text-pretty text-muted-foreground">{children}</p> : null}
    </header>
  )
}

/* A line on the rail, drawn exactly as the main window draws it. */

function RailLine({
  time,
  speaker,
  color,
  text,
  state,
  className,
}: {
  time: string
  speaker?: string
  color?: string
  text: string
  state: "past" | "live" | "listening"
  className?: string
}) {
  return (
    <li className={cn("relative grid grid-cols-[44px_30px_1fr] gap-x-3 py-3", className)}>
      {/* Each row draws its own stretch of the rail, so the line runs unbroken through the list. */}
      <span aria-hidden className={cn("absolute top-0 bottom-0 left-[71px] w-px", state === "listening" ? "onb-dash-y" : "bg-rail/70")} />
      <span className="tabular pt-[2px] text-right text-[13px] text-faint">{time}</span>
      <span aria-hidden className="relative">
        {state === "live" ? (
          <span className="absolute top-[9px] left-[3px] block h-[7px] w-[24px] bg-background">
            <span className="absolute top-0 left-0 block h-[2px] w-full bg-live" />
            <span className="absolute top-[5px] left-0 block h-[2px] w-full bg-live" />
          </span>
        ) : state === "past" ? (
          <span className="absolute top-[12px] left-[3px] block h-px w-[24px] bg-foreground/75" />
        ) : (
          <span className="onb-dash-x absolute top-[12px] left-[3px] block h-px w-[24px]" />
        )}
      </span>
      <div className="min-w-0">
        {speaker ? (
          <p className="text-[14px] font-semibold" style={color ? { color } : undefined}>
            {speaker}
          </p>
        ) : null}
        <p className={cn("text-[14px] leading-[1.45]", state === "listening" ? "text-faint italic" : "text-foreground/85")}>{text}</p>
      </div>
    </li>
  )
}

const SAMPLE = [
  { time: "00:04", speaker: "Alex Rivera (You)", text: "Thanks for jumping on. Let's lock the launch date." },
  { time: "00:12", speaker: "Priya Shah", color: SPEAKER_PALETTE[0], text: "Engineering is ready for the fourteenth." },
  { time: "00:24", speaker: "Sam Okafor", color: SPEAKER_PALETTE[1], text: "Marketing can hit that if the copy is final by Friday." },
]

function SampleCall() {
  const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  const [shown, setShown] = useState(reduced ? SAMPLE.length : 1)
  useEffect(() => {
    if (reduced) return
    const timer = window.setTimeout(() => setShown((count) => (count >= SAMPLE.length ? 1 : count + 1)), shown >= SAMPLE.length ? 4200 : 2100)
    return () => window.clearTimeout(timer)
  }, [shown, reduced])
  return (
    <figure className="flex flex-col gap-2" aria-label="A sample call transcribed on the rail">
      <ol className="border-t border-border pt-2">
        {SAMPLE.slice(0, shown).map((line, index) => (
          <RailLine key={`${line.time}-${shown === 1 ? "a" : "b"}`} {...line} state={index === shown - 1 ? "live" : "past"} className={index === shown - 1 ? "onb-line-in" : undefined} />
        ))}
        <RailLine time="--:--" text="Listening for more speech…" state="listening" />
      </ol>
      <figcaption className="pl-[56px] text-[12px] text-faint">Sample call. Voices are told apart on this Mac; name someone once and they’re known next time.</figcaption>
    </figure>
  )
}

/* Steps */

function WelcomeStep() {
  return (
    <>
      <StepHeader eyebrow="Welcome to Meeting Notes" title={<>Your calls, written down.<br />Your voice, typed anywhere.</>}>
        Meeting Notes transcribes your calls live on this Mac, tells speakers apart and writes the notes for you. Between calls, hold a key and
        speak to type in any app.
      </StepHeader>
      <SampleCall />
      <p className="mt-8 text-[13px] text-muted-foreground">Setup takes about two minutes. Audio never leaves your Mac.</p>
    </>
  )
}

function NameStep({ name, setName }: { name: string; setName: (value: string) => void }) {
  return (
    <>
      <StepHeader title="What should we call you?">
        Your side of every transcript is labelled with this name. Everyone else is told apart by voice, and named from Zoom or your calendar
        invite.
      </StepHeader>
      <Field>
        <FieldLabel htmlFor="onb-name" className="sr-only">
          Your name
        </FieldLabel>
        <Input
          id="onb-name"
          autoFocus
          value={name}
          maxLength={80}
          placeholder="Your name"
          onChange={(event) => setName(event.target.value)}
          className="h-11 max-w-[360px] text-[16px]"
        />
      </Field>
      <ol className="mt-8 border-t border-border pt-2" aria-label="Preview">
        <RailLine time="00:04" speaker={`${name.trim() || "Me"} (You)`} text="Thanks for jumping on. Let's get started." state="past" />
      </ol>
    </>
  )
}

const PERMISSION_ROWS: { kind: keyof OnboardingPermissions; title: string; need: string; why: string }[] = [
  { kind: "microphone", title: "Microphone", need: "Required", why: "To hear you." },
  {
    kind: "screen",
    title: "Screen & System Audio Recording",
    need: "Required",
    why: "To hear everyone else on the call (macOS files system audio here), and to save slides they share. Nothing else on screen is kept.",
  },
  {
    kind: "accessibility",
    title: "Accessibility",
    need: "Recommended",
    why: "For the shortcuts (dictation, Ask, Edit and live help), to type dictation into other apps, and to read speaker names from Zoom.",
  },
]

function PermissionsStep({ permissions, onRequest }: { permissions: OnboardingPermissions | null; onRequest: (kind: keyof OnboardingPermissions) => Promise<void> }) {
  const [asking, setAsking] = useState<string | null>(null)
  const [asked, setAsked] = useState<Set<string>>(new Set())
  return (
    <>
      <StepHeader title="Let Meeting Notes listen">
        macOS asks once for each of these. Meeting Notes records sound only, and it stays on this Mac.
      </StepHeader>
      <ItemGroup className="gap-0 border-t border-border">
        {PERMISSION_ROWS.map((row) => {
          const granted = permissions?.[row.kind] === "granted"
          return (
            <Item key={row.kind} className="relative items-start rounded-none border-0 border-b border-border py-4 pr-0 pl-9 last:border-b-0">
              <span aria-hidden className="absolute top-[26px] left-0 block w-[22px]">
                {granted ? <span className="block h-px w-full bg-foreground/75" /> : <span className="onb-dash-x block h-px w-full" />}
              </span>
              <ItemContent className="gap-1">
                <ItemTitle className="flex items-center gap-2 text-[14px]">
                  {row.title}
                  <span className="text-[12px] font-normal text-faint">{row.need}</span>
                </ItemTitle>
                <ItemDescription className="text-[12px] leading-[1.45]">{row.why}</ItemDescription>
                {granted && row.kind === "microphone" ? (
                  <div className="pt-2">
                    <MicrophoneTest deviceId={null} />
                  </div>
                ) : null}
                {!granted && asked.has(row.kind) ? (
                  <p className="text-[12px] leading-[1.45] text-faint">
                    {row.kind === "screen"
                      ? "Turn on Meeting Notes in System Settings. If macOS offers Quit & Reopen, choose it; setup continues where you left off."
                      : "Turn on Meeting Notes in System Settings, then come back here."}
                  </p>
                ) : null}
              </ItemContent>
              <div className="self-center">
                {!permissions ? (
                  <Spinner className="size-3.5 text-muted-foreground" />
                ) : granted ? (
                  <span className="flex items-center gap-1.5 text-[13px] text-foreground/85">
                    <HugeiconsIcon icon={Tick02Icon} className="size-4" strokeWidth={2} /> Allowed
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={asking === row.kind}
                    onClick={async () => {
                      setAsking(row.kind)
                      try {
                        await onRequest(row.kind)
                      } finally {
                        setAsking(null)
                        setAsked((current) => new Set(current).add(row.kind))
                      }
                    }}
                  >
                    {asking === row.kind ? <Spinner className="size-3.5" /> : null}
                    Allow…
                  </Button>
                )}
              </div>
            </Item>
          )
        })}
      </ItemGroup>
    </>
  )
}

const ONBOARDING_MODELS = ["phonon-2", "parakeet-tdt-0.6b-v3"]

function ModelStep({ models, progress, setModels, setProgress }: {
  models: ModelListState | null
  progress: Record<string, ModelProgress>
  setModels: (state: ModelListState) => void
  setProgress: (update: (current: Record<string, ModelProgress>) => Record<string, ModelProgress>) => void
}) {
  const [error, setError] = useState("")
  const run = async (action: () => Promise<unknown>) => {
    setError("")
    try {
      await action()
    } catch (failure) {
      setError(cleanError(failure))
    }
  }
  const entries = models?.catalog.filter((entry) => ONBOARDING_MODELS.includes(entry.id)) || []
  return (
    <>
      <StepHeader title="Choose how speech is transcribed">
        Both run on this Mac and transcribe while people talk. Download one now; it keeps downloading if you carry on.
      </StepHeader>
      {!models ? (
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Spinner className="size-3.5" /> Checking this Mac…
        </p>
      ) : (
        <ItemGroup className="gap-0 border-t border-border">
          {entries.map((entry) => {
            const installed = entry.installedModelId
            return (
              <ModelRow
                key={entry.id}
                model={{
                  label: entry.id === "phonon-2" ? "Phonon-2 · Recommended" : "Parakeet v3",
                  meta: `${entry.languages} · ${entry.sizeLabel}`,
                  detail: entry.id === "phonon-2" ? "The most accurate choice for English calls." : "For calls in other European languages.",
                  live: entry.realtime,
                }}
                progress={progress[entry.id] || entry.progress}
                selected={Boolean(installed) && installed === models.selectedId}
                onUse={installed ? () => run(async () => setModels(await window.meetingRecorder.selectModel(installed))) : undefined}
                onDownload={
                  installed
                    ? undefined
                    : () =>
                        run(async () => {
                          setProgress((current) => ({ ...current, [entry.id]: { id: entry.id, state: "starting", message: "Starting…" } }))
                          await window.meetingRecorder.installModel(entry.id)
                        })
                }
                onCancel={() => run(() => window.meetingRecorder.cancelModelInstall(entry.id))}
              />
            )
          })}
        </ItemGroup>
      )}
      {error ? <FieldError className="mt-3">{error}</FieldError> : null}
      <p className="mt-6 text-[12px] text-faint">Whisper and other models are in Settings, Transcription.</p>
    </>
  )
}

function NotesStep({ settings, save }: { settings: SettingsState; save: Save }) {
  const [key, setKey] = useState("")
  const [saving, setSaving] = useState(false)
  const submit = async () => {
    setSaving(true)
    if (await save({ openRouterKey: key })) setKey("")
    setSaving(false)
  }
  return (
    <>
      <StepHeader title="Turn transcripts into notes">
        After each call you get a summary, the decisions made and action items with owners. They're written through OpenRouter with a model you
        pick. Only the transcript text is sent; audio stays here.
      </StepHeader>
      <Field>
        <FieldLabel htmlFor="onb-key">OpenRouter API key</FieldLabel>
        {settings.hasOpenRouterKey ? (
          <p className="flex items-center gap-2 text-[14px] text-foreground/90">
            <HugeiconsIcon icon={Tick02Icon} className="size-4" strokeWidth={2} /> A key is saved
          </p>
        ) : (
          <div className="flex max-w-[460px] gap-2">
            <Input
              id="onb-key"
              type="password"
              autoComplete="off"
              value={key}
              placeholder="sk-or-…"
              onChange={(event) => setKey(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && key.trim() && void submit()}
            />
            <Button disabled={!key.trim() || saving} onClick={() => void submit()}>
              Save key
            </Button>
          </div>
        )}
        <FieldDescription>
          Create one at{" "}
          <button type="button" className="text-foreground underline underline-offset-4" onClick={() => void window.meetingRecorder.openNote("https://openrouter.ai/keys")}>
            openrouter.ai/keys
          </button>
          . It's encrypted with macOS secure storage. You can skip this and add it later in Settings; calls are still transcribed without it.
        </FieldDescription>
      </Field>
      <div className="mt-8 border-t border-border pt-4">
        <p className="text-[13px] font-medium text-foreground/90">The key also turns on</p>
        <ul className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[13px] text-muted-foreground">
          {[
            "Ask your meetings anything",
            "Live help during calls",
            "Prep cards before calls",
            "Weekly digests",
            "Follow-up drafts",
            "AI cleanup for dictation",
          ].map((item) => (
            <li key={item} className="flex items-center gap-2">
              <span aria-hidden className="block h-px w-3 bg-foreground/45" />
              {item}
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}

const DESTINATIONS: { value: NotesDestination; title: string }[] = [
  { value: "folder", title: "A folder on this Mac" },
  { value: "notion", title: "Notion" },
  { value: "both", title: "Both" },
]

function DestinationStep({ settings, save }: { settings: SettingsState; save: Save }) {
  return (
    <>
      <StepHeader title="Where should notes go?">Recordings always stay in your folder. You can change this any time in Settings.</StepHeader>
      <ItemGroup className="gap-0 border-t border-border" role="radiogroup" aria-label="Save notes to">
        {DESTINATIONS.map((option) => {
          const selected = settings.notesDestination === option.value
          return (
            <Item
              key={option.value}
              asChild
              className={cn(
                "relative cursor-default rounded-none border-0 border-b border-border py-4 pr-0 pl-9 text-left last:border-b-0 hover:bg-transparent",
                selected ? "" : "opacity-80 hover:opacity-100",
              )}
            >
              <button type="button" role="radio" aria-checked={selected} onClick={() => void save({ notesDestination: option.value })}>
                <span aria-hidden className="absolute top-[26px] left-0 block w-[22px]">
                  {selected ? (
                    <>
                      <span className="absolute -top-[3px] left-0 block h-[2px] w-full bg-foreground" />
                      <span className="absolute top-[2px] left-0 block h-[2px] w-full bg-foreground" />
                    </>
                  ) : (
                    <span className="onb-dash-x block h-px w-full" />
                  )}
                </span>
                <ItemContent className="gap-1">
                  <ItemTitle className={cn("text-[14px]", selected && "font-semibold")}>{option.title}</ItemTitle>
                  <ItemDescription className="text-[12px] leading-[1.45]">{DESTINATION_HELP[option.value]}</ItemDescription>
                </ItemContent>
              </button>
            </Item>
          )
        })}
      </ItemGroup>
      <div className="mt-6 flex flex-col gap-6">
        <Field>
          <FieldLabel htmlFor="onb-folder">{settings.notesDestination === "notion" ? "Recordings folder" : "Folder"}</FieldLabel>
          <div className="flex max-w-[460px] gap-2">
            <Input id="onb-folder" readOnly value={settings.notesDir.replace(/^\/Users\/[^/]+/, "~")} className="text-muted-foreground" />
            <Button
              variant="secondary"
              onClick={async () => {
                const folder = await window.meetingRecorder.chooseNotesFolder()
                if (folder) await save({ notesDir: folder })
              }}
            >
              Choose…
            </Button>
          </div>
        </Field>
        {settings.notesDestination !== "folder" ? <NotionPanel settings={settings} save={save} /> : null}
      </div>
    </>
  )
}

/* The dictation pill as it appears over other apps, with a simulated voice so it moves. */

const PILL_WORDS = "Send Priya the pricing numbers before Thursday".split(" ")

function PillDemo({ hotkey, verb }: { hotkey: string; verb: string }) {
  const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  const lines = useRef<(HTMLSpanElement | null)[]>([])
  const [words, setWords] = useState(reduced ? PILL_WORDS.length : 0)
  useEffect(() => {
    if (reduced) return
    let frame = 0
    const tick = window.setInterval(() => {
      frame += 1
      const voice = 0.45 + 0.4 * Math.abs(Math.sin(frame / 2.3)) * (0.6 + Math.random() * 0.4)
      lines.current.forEach((line, index) => {
        if (!line) return
        const shape = 0.35 + 0.65 * Math.sin(((index + 1) / 10) * Math.PI)
        line.style.transform = `scaleY(${Math.max(3, 3 + 15 * voice * shape * (0.75 + Math.random() * 0.5)) / 18})`
      })
    }, 90)
    const typing = window.setInterval(() => setWords((count) => (count >= PILL_WORDS.length + 6 ? 0 : count + 1)), 380)
    return () => {
      window.clearInterval(tick)
      window.clearInterval(typing)
    }
  }, [reduced])
  return (
    <figure className="mb-8 flex flex-col gap-4" aria-label="Preview of dictation">
      <div className="flex min-h-[52px] items-center rounded-md border border-border bg-muted/50 px-4 text-[15px] text-foreground/90">
        <span>{PILL_WORDS.slice(0, Math.min(words, PILL_WORDS.length)).join(" ")}</span>
        <span aria-hidden className="ml-px inline-block h-[18px] w-px animate-pulse bg-foreground/70" />
      </div>
      <div className="flex items-center justify-center gap-4">
        <div className="flex h-10 items-center gap-3 rounded-[20px] border border-white/10 bg-background/95 pr-4 pl-3.5 text-[13px] font-medium shadow-[0_8px_24px_rgb(0_0_0/0.35)]">
          <span aria-hidden className="flex h-[18px] items-center gap-[3px]">
            {Array.from({ length: 9 }, (_, index) => (
              <span
                key={index}
                ref={(element) => {
                  lines.current[index] = element
                }}
                className="h-[18px] w-px origin-center scale-y-[0.5] bg-live transition-transform duration-75 ease-linear"
              />
            ))}
          </span>
          Listening
        </div>
        <span className="text-[12px] text-faint">
          {verb} <Kbd className="mx-0.5 text-[12px] text-foreground">{hotkey}</Kbd> to talk
        </span>
      </div>
    </figure>
  )
}

function CallsStep({ settings, save }: { settings: SettingsState; save: Save }) {
  const [folders, setFolders] = useState<string[]>(settings.knowledgeFolders || [])
  return (
    <>
      <StepHeader title="Before and during your calls">
        All optional, and all can be changed later in Settings.
      </StepHeader>
      <div className="flex flex-col gap-6">
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="onb-auto">Record calls automatically</FieldLabel>
            <FieldDescription>
              Zoom, Google Meet, Teams, Slack huddles, FaceTime and more, in the app or the browser. Starts a few seconds into a call and stops
              when it ends.
            </FieldDescription>
          </FieldContent>
          <Switch id="onb-auto" checked={settings.autoRecordZoomMeetings} onCheckedChange={(checked) => void save({ autoRecordZoomMeetings: checked })} />
        </Field>
        <div className="flex flex-col gap-6 border-t border-border pt-6">
          <CalendarField settings={settings} save={save} />
        </div>
        <Field orientation="horizontal" className="border-t border-border pt-6">
          <FieldContent>
            <FieldLabel htmlFor="onb-screens">Capture shared screens</FieldLabel>
            <FieldDescription>
              When someone shares slides, a picture of each new one is saved with its text, read on this Mac. The notes get a Shared on screen
              section and live help knows what's on screen.
            </FieldDescription>
          </FieldContent>
          <Switch id="onb-screens" checked={settings.captureSharedScreens !== false} onCheckedChange={(checked) => void save({ captureSharedScreens: checked })} />
        </Field>
        <Field className="border-t border-border pt-6">
          <FieldLabel>Knowledge base</FieldLabel>
          <FieldDescription>
            A folder of your own documents, like sales playbooks, call scripts or product notes. Ask, prep cards and live help use them and cite
            the file. You can also connect MCP servers in Settings.
          </FieldDescription>
          {folders.length ? (
            <ul className="flex flex-col gap-1 text-[13px] text-foreground/90">
              {folders.map((folder) => (
                <li key={folder} className="flex items-center gap-2">
                  <HugeiconsIcon icon={Tick02Icon} className="size-3.5" strokeWidth={2} />
                  {folder.replace(/^\/Users\/[^/]+/, "~")}
                </li>
              ))}
            </ul>
          ) : null}
          <div>
            <Button size="sm" variant="secondary" onClick={async () => setFolders(await window.meetingRecorder.addKnowledgeFolder())}>
              {folders.length ? "Add another folder…" : "Add a folder…"}
            </Button>
          </div>
        </Field>
      </div>
    </>
  )
}

function Check({ done, children }: { done: boolean; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[22px_1fr] items-start gap-x-2">
      <span aria-hidden className="pt-[3px]">
        {done ? <HugeiconsIcon icon={Tick02Icon} className="size-4 text-gold" strokeWidth={2.2} /> : <span className="mt-[7px] block onb-dash-x h-px w-[14px]" />}
      </span>
      <span className={cn("text-[13px] leading-[1.5]", done ? "text-foreground/90" : "text-muted-foreground")}>{children}</span>
    </li>
  )
}

/** Dictation, then Edit by voice, tried on the spot: each ticks off when it lands. */
function TryDictation({ settings, save, ready, verb }: { settings: SettingsState; save: Save; ready: boolean; verb: string }) {
  const [text, setText] = useState("")
  const [dictated, setDictated] = useState(false)
  const [edited, setEdited] = useState(false)
  const canEdit = settings.hasOpenRouterKey && settings.commandModeEnabled !== false
  const commandKey = settings.commandHotkeyLabel || "Right ⌥ + Right ⌘"

  // Typing adds a character at a time; dictation and Edit by voice arrive all at once.
  const onChange = (next: string) => {
    const jump = Math.abs(next.length - text.length) >= 3 || (text.length > 3 && next.length > 3 && !next.startsWith(text.slice(0, 3)))
    if (jump && next.trim()) {
      if (!dictated) setDictated(true)
      else if (text.trim() && !next.startsWith(text)) setEdited(true)
    }
    setText(next)
  }

  return (
    <Field>
      <FieldLabel htmlFor="onb-try">Try it</FieldLabel>
      <Textarea
        id="onb-try"
        rows={3}
        disabled={!ready}
        value={text}
        onChange={(event) => onChange(event.target.value)}
        placeholder={ready ? `Click here, ${verb.toLowerCase()} ${settings.dictationHotkeyLabel} and say a sentence.` : "Getting the model ready…"}
        className="resize-none text-[15px]"
      />
      {ready ? (
        <ol className="flex flex-col gap-1.5 pt-1">
          <Check done={dictated}>
            Dictate a sentence. Try a correction too: “let's meet Tuesday, no wait, Wednesday”.
          </Check>
          {canEdit ? (
            <Check done={edited}>
              Select what you dictated, hold <Kbd className="h-5 px-1.5 text-[11px] text-foreground">{commandKey}</Kbd> and say “make this
              more formal”.
            </Check>
          ) : null}
        </ol>
      ) : (
        <FieldDescription>The first start loads the model; it takes a few seconds.</FieldDescription>
      )}
      {dictated ? (
        <Field orientation="horizontal" className="pt-2">
          <FieldContent>
            <FieldLabel htmlFor="onb-whisper">Whisper mode</FieldLabel>
            <FieldDescription>In a quiet office? Turn this on and try dictating under your breath.</FieldDescription>
          </FieldContent>
          <Switch id="onb-whisper" checked={settings.dictationWhisper === true} onCheckedChange={(checked) => void save({ dictationWhisper: checked })} />
        </Field>
      ) : null}
    </Field>
  )
}

const PRACTICE_PROMPTS = ["What are you working on this week?", "Pitch what you do in thirty seconds.", "Walk us through a decision you made recently."]
const PRACTICE_LIMIT_S = 60
const FILLER_WORDS = /(?<![\p{L}'])(um|uh|erm|you know|i mean|basically|literally|actually|sort of|kind of)(?![\p{L}'])/giu

function practiceTip(result: PracticeResult) {
  const top = result.topFillers[0]
  if (result.words < 15) return "That was short. Try again and keep going for about twenty seconds."
  if (result.fillersPer100 >= 4 && top) {
    const said = top.count > 1 ? `“${top.word}” came up ${top.count} times` : `${result.fillers} fillers crept in (${result.topFillers.map((filler) => filler.word).join(", ")})`
    return `${said}. A short pause reads as more sure than a filler.`
  }
  if (result.wordsPerMinute !== null && result.wordsPerMinute > 180) return "Quick! Slowing down a little makes key points easier to follow."
  if (result.wordsPerMinute !== null && result.wordsPerMinute < 110) return "Nice and measured. On calls a touch more pace keeps people with you."
  return "Clear and steady, with few fillers. After each real call you get the same breakdown, plus your share of the talking."
}

function Highlighted({ text }: { text: string }) {
  const parts = text.split(FILLER_WORDS)
  return (
    <p className="text-[14px] leading-[1.6] text-foreground/85">
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <mark key={index} className="rounded-sm bg-gold-soft px-0.5 text-gold">
            {part}
          </mark>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </p>
  )
}

/** A short talk, scored by the speaking coach, so you see what you'll get after each call. */
function PracticeStep() {
  const [phase, setPhase] = useState<"idle" | "recording" | "working" | "done">("idle")
  const [started, setStarted] = useState(0)
  const [now, setNow] = useState(0)
  const [result, setResult] = useState<PracticeResult | null>(null)
  const [error, setError] = useState("")
  const [prompt, setPrompt] = useState(0)
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  useEffect(() => () => void (phaseRef.current === "recording" && window.meetingRecorder.cancelPractice()), [])

  const stop = useCallback(async () => {
    setPhase("working")
    try {
      const next = await window.meetingRecorder.stopPractice()
      setResult(next)
      setPhase(next ? "done" : "idle")
    } catch (failure) {
      setError(cleanError(failure))
      setPhase("idle")
    }
  }, [])

  useEffect(() => {
    if (phase !== "recording") return
    const timer = window.setInterval(() => {
      const current = Date.now()
      setNow(current)
      if (current - started >= PRACTICE_LIMIT_S * 1000) void stop()
    }, 250)
    return () => window.clearInterval(timer)
  }, [phase, started, stop])

  const start = async () => {
    setError("")
    setResult(null)
    try {
      await window.meetingRecorder.startPractice()
      const current = Date.now()
      setStarted(current)
      setNow(current)
      setPhase("recording")
    } catch (failure) {
      setError(cleanError(failure))
    }
  }

  const elapsed = Math.max(0, Math.floor((now - started) / 1000))
  return (
    <>
      <StepHeader title="Practice with the speaking coach">
        After every call you get a breakdown of how you spoke. Try it now: talk for about twenty seconds, the way you would on a call. It's
        transcribed on this Mac and not kept.
      </StepHeader>
      <div className="rounded-lg border border-border bg-panel p-5">
        <p className="text-[12px] text-faint">Say something like</p>
        <p className="mt-1 text-[17px] leading-[1.4] text-foreground">{PRACTICE_PROMPTS[prompt]}</p>
        <div className="mt-5 flex items-center gap-3">
          {phase === "recording" ? (
            <>
              <Button variant="secondary" onClick={() => void stop()}>
                Stop
              </Button>
              <span className="flex items-center gap-2 text-[13px] text-foreground/85">
                <span aria-hidden className="block size-2 animate-pulse rounded-full bg-rec" />
                <span className="tabular">0:{String(elapsed).padStart(2, "0")}</span>
                <span className="text-muted-foreground">{elapsed < 15 ? "Keep going…" : "Stop when you're done"}</span>
              </span>
            </>
          ) : phase === "working" ? (
            <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Spinner className="size-3.5" /> Listening back…
            </span>
          ) : (
            <>
              <Button onClick={() => void start()}>{result ? "Try again" : "Start talking"}</Button>
              <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setPrompt((current) => (current + 1) % PRACTICE_PROMPTS.length)}>
                Another prompt
              </Button>
            </>
          )}
        </div>
      </div>
      {error ? <FieldError className="mt-3">{error}</FieldError> : null}
      {result && phase === "done" ? (
        <section className="mt-6 flex flex-col gap-4" aria-label="Your practice">
          <dl className="grid grid-cols-4 gap-4 border-y border-border py-4">
            {[
              ["Pace", result.wordsPerMinute ? `${result.wordsPerMinute} wpm` : "–"],
              ["Fillers per 100", result.fillersPer100.toFixed(1)],
              ["Words", String(result.words)],
              ["Questions", String(result.questions)],
            ].map(([label, value]) => (
              <div key={label} className="flex flex-col gap-1">
                <dt className="text-[12px] text-faint">{label}</dt>
                <dd className="tabular text-[20px] leading-none text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-[14px] text-foreground/90">{practiceTip(result)}</p>
          {result.text ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-[12px] text-faint">What you said{result.fillers ? ", fillers marked" : ""}</p>
              <Highlighted text={result.text} />
            </div>
          ) : (
            <p className="text-[13px] text-muted-foreground">Nothing was heard. Check your microphone on the Permissions step and try again.</p>
          )}
        </section>
      ) : null}
    </>
  )
}

function OtherShortcuts({ settings }: { settings: SettingsState }) {
  const rows = [
    [settings.askHotkeyLabel || "Right ⌘", "Ask your meetings a question out loud"],
    [settings.commandHotkeyLabel || "Right ⌥ + Right ⌘", "Select text anywhere and say how to change it"],
    [settings.liveHelpHotkeyLabel || "Right ⇧ + Right ⌘", "During a call: suggestions from what's been said"],
  ]
  return (
    <div className="border-t border-border pt-4">
      <p className="text-[13px] font-medium text-foreground/90">Three more shortcuts, ready when you are</p>
      <dl className="mt-3 grid grid-cols-[minmax(150px,auto)_1fr] items-center gap-x-4 gap-y-2.5">
        {rows.map(([keys, does]) => (
          <div key={does} className="contents">
            <dt>
              <Kbd className="h-6 px-2 text-[12px] text-foreground">{keys}</Kbd>
            </dt>
            <dd className="text-[13px] text-muted-foreground">{does}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-[12px] text-faint">Change them in Settings → Dictation.</p>
    </div>
  )
}

function DictationStep({ settings, save, onRequestAccessibility }: { settings: SettingsState; save: Save; onRequestAccessibility: () => Promise<void> }) {
  const [status, setStatus] = useState<DictationStatus | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    void window.meetingRecorder.getDictationStatus().then(setStatus)
  }, [settings.dictationEnabled, settings.dictationHotkeyLabel])
  useBridgeEvents({ dictationStatus: setStatus })

  useEffect(() => {
    if (!capturing) return
    return () => void window.meetingRecorder.cancelHotkeyCapture()
  }, [capturing])

  const capture = async () => {
    if (capturing) {
      await window.meetingRecorder.cancelHotkeyCapture()
      return
    }
    setError("")
    setCapturing(true)
    try {
      const result = await window.meetingRecorder.captureHotkey()
      if (result) await save({ dictationHotkey: result.hotkey })
    } catch (failure) {
      setError(cleanError(failure))
    } finally {
      setCapturing(false)
    }
  }

  const verb = settings.dictationMode === "toggle" ? "Press" : "Hold"
  const ready = settings.dictationEnabled && status?.running && status.tap !== false

  return (
    <>
      <StepHeader title="Type with your voice, anywhere">
        {verb} a key, speak, and let go. Your words are typed where your cursor is, or copied when there's no text field. Esc cancels.
      </StepHeader>
      <PillDemo hotkey={settings.dictationHotkeyLabel} verb={verb} />
      <div className="flex flex-col gap-6">
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="onb-dictation">Dictate with a shortcut</FieldLabel>
            <FieldDescription>Uses the same on-device model as your calls.</FieldDescription>
          </FieldContent>
          <Switch id="onb-dictation" checked={settings.dictationEnabled} onCheckedChange={(checked) => void save({ dictationEnabled: checked })} />
        </Field>
        {settings.dictationEnabled ? (
          <>
            <Field>
              <FieldLabel>Shortcut</FieldLabel>
              <div className="flex items-center gap-3">
                <Kbd className={cn("h-9 min-w-[140px] justify-start px-3 text-[14px] text-foreground", capturing && "text-muted-foreground ring-2 ring-foreground/40")}>
                  {capturing ? "Press your shortcut…" : settings.dictationHotkeyLabel}
                </Kbd>
                <Button size="sm" variant="secondary" onClick={() => void capture()}>
                  {capturing ? "Cancel" : "Change…"}
                </Button>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  value={settings.dictationMode}
                  onValueChange={(value) => value && void save({ dictationMode: value })}
                  className="ml-auto"
                >
                  <ToggleGroupItem value="hold" className="px-3 data-[state=on]:border-foreground/40 data-[state=on]:bg-foreground/10 data-[state=on]:text-foreground">
                    Hold
                  </ToggleGroupItem>
                  <ToggleGroupItem value="toggle" className="px-3 data-[state=on]:border-foreground/40 data-[state=on]:bg-foreground/10 data-[state=on]:text-foreground">
                    Press to start
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
              {error ? <FieldError>{error}</FieldError> : null}
            </Field>
            {status?.tap === false ? (
              <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
                <p className="text-[13px] text-rec">Dictation needs Accessibility access to notice the shortcut.</p>
                <Button size="sm" variant="secondary" onClick={() => void onRequestAccessibility()}>
                  Allow…
                </Button>
              </div>
            ) : (
              <TryDictation settings={settings} save={save} ready={Boolean(ready)} verb={verb} />
            )}
          </>
        ) : null}
        <OtherShortcuts settings={settings} />
      </div>
    </>
  )
}

const FIND_LATER = [
  ["Speaking coach", "Talk share, pace and filler words for each call", "Meetings, under any call"],
  ["Dictation history", "Everything you've dictated, to search and copy again", "Dictation, in the sidebar"],
  ["Snippets", "Say “my calendar link” and get the full text", "Settings → Dictionary"],
  ["Whisper mode", "Dictate under your breath in a quiet room", "Settings → Dictation"],
  ["Claude, Cursor and Terminal", "Let your AI apps search your calls", "Settings → AI apps"],
]

function MenuBarIcon({ recording }: { recording: boolean }) {
  return (
    <span className="flex items-center gap-1">
      <span className="flex h-3.5 items-center gap-[2px]">
        {[5, 9, 13, 9, 5].map((height, index) => (
          <span key={index} className="block w-[2px] rounded-full bg-foreground" style={{ height }} />
        ))}
      </span>
      {recording ? <span className="block size-[6px] rounded-full bg-rec shadow-[0_0_6px_var(--rec)]" /> : null}
    </span>
  )
}

function DoneStep({ settings, save, models }: { settings: SettingsState; save: Save; models: ModelListState | null }) {
  const model = models?.installed.find((entry) => entry.id === models.selectedId)
  const downloading = models?.catalog.find((entry) => entry.progress && !entry.installedModelId)
  const knowledge = settings.knowledgeFolders?.length || 0
  const rows = [
    { label: "Your name", value: settings.speakerName, ok: true },
    {
      label: "Transcription",
      value: model ? model.label : downloading ? `${downloading.label}, still downloading` : "No model yet. Add one in Settings.",
      ok: Boolean(model),
    },
    { label: "AI notes", value: settings.hasOpenRouterKey ? "On, through OpenRouter" : "Off until you add a key", ok: settings.hasOpenRouterKey },
    {
      label: "Notes go to",
      value: { folder: "Your folder", notion: "Notion", both: "Your folder and Notion" }[settings.notesDestination],
      ok: true,
    },
    { label: "Calls", value: settings.autoRecordZoomMeetings ? "Recorded automatically" : "You start each recording", ok: true },
    { label: "Calendar", value: settings.calendarEnabled ? "Names calls and preps you" : "Off", ok: Boolean(settings.calendarEnabled) },
    { label: "Knowledge base", value: knowledge ? `${knowledge} ${knowledge === 1 ? "folder" : "folders"}` : "None yet", ok: knowledge > 0 },
    { label: "Dictation", value: settings.dictationEnabled ? `${settings.dictationMode === "toggle" ? "Press" : "Hold"} ${settings.dictationHotkeyLabel}` : "Off", ok: settings.dictationEnabled },
  ]
  return (
    <>
      <StepHeader title="You're set">
        Meeting Notes lives in your menu bar as a small waveform. A red dot appears beside it while a call is recording.
      </StepHeader>
      <div aria-hidden className="mb-6 flex h-9 items-center justify-end gap-5 rounded-md border border-border bg-muted px-4 text-[13px] text-faint">
        <HugeiconsIcon icon={BatteryFullIcon} className="size-4" strokeWidth={1.6} />
        <HugeiconsIcon icon={Wifi01Icon} className="size-4" strokeWidth={1.6} />
        <HugeiconsIcon icon={Search01Icon} className="size-[15px]" strokeWidth={1.6} />
        <span className="rounded-sm bg-foreground/15 px-1.5 py-1">
          <MenuBarIcon recording />
        </span>
        <span className="tabular">9:41</span>
      </div>
      <ol className="grid grid-cols-2 gap-x-6 border-t border-border">
        {rows.map((row) => (
          <li key={row.label} className="relative grid grid-cols-[22px_1fr] items-start gap-x-2 border-b border-border py-2.5">
            <span aria-hidden className="pt-[9px]">
              {row.ok ? <span className="block h-px w-[14px] bg-foreground/75" /> : <span className="onb-dash-x block h-px w-[14px]" />}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-[12px] text-muted-foreground">{row.label}</span>
              <span className={cn("truncate text-[13px]", row.ok ? "text-foreground/90" : "text-faint")} title={row.value}>
                {row.value}
              </span>
            </span>
          </li>
        ))}
      </ol>
      <Field orientation="horizontal" className="mt-6">
        <FieldContent>
          <FieldLabel htmlFor="onb-login">Open at login</FieldLabel>
          <FieldDescription>So calls are noticed and dictation works without opening the app first.</FieldDescription>
        </FieldContent>
        <Switch id="onb-login" checked={Boolean(settings.launchAtLogin)} onCheckedChange={(checked) => void save({ launchAtLogin: checked })} />
      </Field>
      <section className="mt-8 border-t border-border pt-4" aria-label="Find later">
        <p className="text-[13px] font-medium text-foreground/90">Find later</p>
        <ul className="mt-2 flex flex-col">
          {FIND_LATER.map(([title, what, where]) => (
            <li key={title} className="grid grid-cols-[1fr_auto] items-baseline gap-4 py-1.5">
              <span className="flex flex-col">
                <span className="text-[13px] text-foreground/90">{title}</span>
                <span className="text-[12px] text-muted-foreground">{what}</span>
              </span>
              <span className="text-[12px] whitespace-nowrap text-faint">{where}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  )
}

/* Window */

export function App() {
  const [settings, setSettings] = useState<SettingsState | null>(null)
  const [step, setStep] = useState(readStep)
  const [reached, setReached] = useState(readStep)
  const [name, setName] = useState("")
  const [error, setError] = useState("")
  const [permissions, setPermissions] = useState<OnboardingPermissions | null>(null)
  const [models, setModels] = useState<ModelListState | null>(null)
  const [progress, setProgress] = useState<Record<string, ModelProgress>>({})
  const [finishing, setFinishing] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const id: StepId = STEPS[step].id

  useEffect(() => {
    void (async () => {
      const current = await window.meetingRecorder.getSettings()
      setSettings(current)
      const suggested = current.speakerName && current.speakerName !== "Me" ? current.speakerName : await window.meetingRecorder.suggestedName()
      setName(suggested || "")
    })()
    void window.meetingRecorder.listModels().then(setModels)
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(STEP_KEY, STEPS[step].id)
    } catch {}
    setReached((current) => Math.max(current, step))
    scrollRef.current?.querySelector("[data-radix-scroll-area-viewport]")?.scrollTo({ top: 0 })
  }, [step])

  // Permissions change in System Settings, not here; keep checking while that step is open.
  useEffect(() => {
    if (id !== "permissions" && id !== "dictation") return
    let alive = true
    const check = async () => {
      const next = await window.meetingRecorder.onboardingPermissions()
      if (alive) setPermissions(next)
    }
    void check()
    const timer = window.setInterval(check, 1500)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [id])

  useBridgeEvents({
    modelProgress: (next) => setProgress((current) => ({ ...current, [next.id]: next })),
    modelsChanged: (next) => {
      setModels(next)
      setProgress((current) => {
        const copy = { ...current }
        for (const entry of next.catalog) {
          const state = copy[entry.id]?.state
          if (state && !entry.progress && state !== "failed") delete copy[entry.id]
        }
        return copy
      })
    },
  })

  const save = useCallback<Save>(async (update) => {
    setError("")
    try {
      const next = await window.meetingRecorder.saveSettings(update)
      setSettings((current) => (current ? { ...current, ...next } : next))
      return true
    } catch (failure) {
      setError(cleanError(failure))
      return false
    }
  }, [])

  const request = useCallback(async (kind: keyof OnboardingPermissions) => {
    setError("")
    try {
      setPermissions(await window.meetingRecorder.requestPermission(kind))
    } catch (failure) {
      setError(cleanError(failure))
    }
  }, [])

  const next = async () => {
    if (id === "you" && name.trim() && name.trim() !== settings?.speakerName && !(await save({ speakerName: name.trim() }))) return
    if (id === "done") {
      setFinishing(true)
      try {
        window.localStorage.removeItem(STEP_KEY)
      } catch {}
      await window.meetingRecorder.finishOnboarding()
      return
    }
    setStep((current) => Math.min(current + 1, STEPS.length - 1))
  }

  if (!settings) {
    return (
      <div className="drag flex h-full items-center justify-center">
        <Spinner className="size-4 text-muted-foreground" />
      </div>
    )
  }

  const installedModel = models?.installed.some((entry) => entry.realtime || entry.catalogId)
  const modelBusy = models?.catalog.some((entry) => (progress[entry.id] || entry.progress) && !entry.installedModelId)
  const requiredMissing = permissions && (permissions.microphone !== "granted" || permissions.screen !== "granted")
  const primary =
    id === "welcome"
      ? "Get started"
      : id === "done"
        ? "Open Meeting Notes"
        : id === "permissions" && requiredMissing
          ? "Continue for now"
          : id === "model" && !installedModel && !modelBusy
            ? "Skip for now"
            : id === "notes" && !settings.hasOpenRouterKey
              ? "Skip for now"
              : "Continue"

  return (
    <div className="flex h-full min-h-0">
      <aside className="drag flex w-[236px] shrink-0 flex-col border-r border-sidebar-border bg-panel pt-[76px] pr-5 pb-7 pl-9">
        <StepRail current={step} reached={reached} onSelect={setStep} />
        <p className="mt-auto flex items-center gap-2 text-[12px] text-faint">
          <span aria-hidden className="flex h-3 items-center gap-[2px]">
            {[5, 9, 12, 9, 5].map((height, index) => (
              <span key={index} className="block w-[2px] rounded-full bg-faint" style={{ height }} />
            ))}
          </span>
          Meeting Notes
        </p>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="drag h-12 shrink-0" />
        <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col">
        <ScrollArea className="min-h-0 flex-1">
          <div key={id} className="onb-enter mx-auto w-full max-w-[560px] px-12 pt-6 pb-12">
            {id === "welcome" ? <WelcomeStep /> : null}
            {id === "you" ? <NameStep name={name} setName={setName} /> : null}
            {id === "permissions" ? <PermissionsStep permissions={permissions} onRequest={request} /> : null}
            {id === "model" ? <ModelStep models={models} progress={progress} setModels={setModels} setProgress={setProgress} /> : null}
            {id === "notes" ? <NotesStep settings={settings} save={save} /> : null}
            {id === "destination" ? <DestinationStep settings={settings} save={save} /> : null}
            {id === "calls" ? <CallsStep settings={settings} save={save} /> : null}
            {id === "practice" ? <PracticeStep /> : null}
            {id === "dictation" ? <DictationStep settings={settings} save={save} onRequestAccessibility={() => request("accessibility")} /> : null}
            {id === "done" ? <DoneStep settings={settings} save={save} models={models} /> : null}
            {error ? <FieldError className="mt-4">{error}</FieldError> : null}
          </div>
        </ScrollArea>
        </div>
        <footer className="flex h-16 shrink-0 items-center justify-between border-t border-border px-8">
          <Button variant="ghost" className={cn(step === 0 && "invisible")} onClick={() => setStep((current) => Math.max(current - 1, 0))}>
            Back
          </Button>
          <span className="tabular text-[12px] text-faint">
            {step + 1} of {STEPS.length}
          </span>
          <Button size="lg" className="min-w-[132px]" disabled={finishing || (id === "you" && !name.trim())} onClick={() => void next()}>
            {finishing ? <Spinner className="size-3.5" /> : null}
            {primary}
          </Button>
        </footer>
      </main>
    </div>
  )
}
