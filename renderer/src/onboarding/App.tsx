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
import { DESTINATION_HELP, ModelRow, NotionPanel, cleanError, type Save } from "@/settings/App"
import { useBridgeEvents } from "@/settings/events"
import type {
  DictationStatus,
  ModelListState,
  ModelProgress,
  NotesDestination,
  OnboardingPermissions,
  SettingsState,
} from "@/types/bridge"

const STEPS = [
  { id: "welcome", label: "Welcome" },
  { id: "you", label: "Your name" },
  { id: "permissions", label: "Permissions" },
  { id: "model", label: "Transcription" },
  { id: "notes", label: "AI notes" },
  { id: "destination", label: "Where notes go" },
  { id: "dictation", label: "Dictation" },
  { id: "done", label: "Ready" },
] as const
type StepId = (typeof STEPS)[number]["id"]

const STEP_KEY = "onboarding-step"

function readStep() {
  try {
    const saved = Number(window.localStorage.getItem(STEP_KEY))
    return Number.isInteger(saved) && saved > 0 && saved < STEPS.length ? saved : 0
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
  text,
  state,
  className,
}: {
  time: string
  speaker?: string
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
        {speaker ? <p className="text-[14px] font-semibold">{speaker}</p> : null}
        <p className={cn("text-[14px] leading-[1.45]", state === "listening" ? "text-faint italic" : "text-foreground/85")}>{text}</p>
      </div>
    </li>
  )
}

const SAMPLE = [
  { time: "00:04", speaker: "Alex Rivera (You)", text: "Thanks for jumping on. Let's lock the launch date." },
  { time: "00:12", speaker: "Priya Shah", text: "Engineering is ready for the fourteenth." },
  { time: "00:24", speaker: "Sam Okafor", text: "Marketing can hit that if the copy is final by Friday." },
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
      <figcaption className="pl-[56px] text-[12px] text-faint">Sample call. Names come from Zoom; nobody is guessed.</figcaption>
    </figure>
  )
}

/* Steps */

function WelcomeStep() {
  return (
    <>
      <StepHeader eyebrow="Welcome to Meeting Notes" title={<>Your calls, written down.<br />Your voice, typed anywhere.</>}>
        Meeting Notes transcribes your meetings live on this Mac and writes the notes for you. Between calls, hold a key and speak to type in any app.
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
        Your side of every transcript is labelled with this name. Other people are named from Zoom.
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
    why: "To hear everyone else on the call. macOS files system audio under screen recording; Meeting Notes only keeps the sound.",
  },
  {
    kind: "accessibility",
    title: "Accessibility",
    need: "Recommended",
    why: "To read speaker names from Zoom and to paste dictation into other apps.",
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
              <Field>
                <FieldLabel htmlFor="onb-try">Try it</FieldLabel>
                <Textarea
                  id="onb-try"
                  rows={3}
                  disabled={!ready}
                  placeholder={ready ? `Click here, ${verb.toLowerCase()} ${settings.dictationHotkeyLabel} and say something.` : "Getting the model ready…"}
                  className="resize-none text-[15px]"
                />
                <FieldDescription>{ready ? "Nothing typed here is saved." : "The first start loads the model; it takes a few seconds."}</FieldDescription>
              </Field>
            )}
          </>
        ) : null}
      </div>
    </>
  )
}

function DoneStep({ settings, save, models }: { settings: SettingsState; save: Save; models: ModelListState | null }) {
  const model = models?.installed.find((entry) => entry.id === models.selectedId)
  const downloading = models?.catalog.find((entry) => entry.progress && !entry.installedModelId)
  const rows = [
    { label: "Your name", value: settings.speakerName, ok: true },
    {
      label: "Transcription",
      value: model ? model.label : downloading ? `${downloading.label}, still downloading` : "No model yet. Add one in Settings.",
      ok: Boolean(model),
    },
    { label: "AI notes", value: settings.hasOpenRouterKey ? "On, through OpenRouter" : "Off until you add an OpenRouter key", ok: settings.hasOpenRouterKey },
    {
      label: "Notes go to",
      value: { folder: "Your folder", notion: "Notion", both: "Your folder and Notion" }[settings.notesDestination],
      ok: true,
    },
    { label: "Dictation", value: settings.dictationEnabled ? `${settings.dictationMode === "toggle" ? "Press" : "Hold"} ${settings.dictationHotkeyLabel}` : "Off", ok: settings.dictationEnabled },
  ]
  return (
    <>
      <StepHeader title="You're set">
        Meeting Notes lives in your menu bar. Look for <span className="font-medium text-foreground">MN</span> at the top of your screen; it reads{" "}
        <span className="font-medium text-rec">REC</span> while a call is recording.
      </StepHeader>
      <div aria-hidden className="mb-8 flex h-9 items-center justify-end gap-5 rounded-md border border-border bg-muted px-4 text-[13px] text-faint">
        <HugeiconsIcon icon={BatteryFullIcon} className="size-4" strokeWidth={1.6} />
        <HugeiconsIcon icon={Wifi01Icon} className="size-4" strokeWidth={1.6} />
        <HugeiconsIcon icon={Search01Icon} className="size-[15px]" strokeWidth={1.6} />
        <span className="rounded-sm bg-foreground/15 px-1.5 py-0.5 font-semibold text-foreground">MN</span>
        <span className="tabular">9:41</span>
      </div>
      <ol className="border-t border-border">
        {rows.map((row) => (
          <li key={row.label} className="relative grid grid-cols-[30px_120px_1fr] items-baseline border-b border-border py-3">
            <span aria-hidden className="self-center">
              {row.ok ? <span className="block h-px w-[22px] bg-foreground/75" /> : <span className="onb-dash-x block h-px w-[22px]" />}
            </span>
            <span className="text-[13px] text-muted-foreground">{row.label}</span>
            <span className={cn("text-[14px]", row.ok ? "text-foreground/90" : "text-faint")}>{row.value}</span>
          </li>
        ))}
      </ol>
      <Field orientation="horizontal" className="mt-6">
        <FieldContent>
          <FieldLabel htmlFor="onb-zoom">Record Zoom meetings automatically</FieldLabel>
          <FieldDescription>Starts when a meeting has someone in it and stops when it ends.</FieldDescription>
        </FieldContent>
        <Switch id="onb-zoom" checked={settings.autoRecordZoomMeetings} onCheckedChange={(checked) => void save({ autoRecordZoomMeetings: checked })} />
      </Field>
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
      window.localStorage.setItem(STEP_KEY, String(step))
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
