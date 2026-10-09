import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  AiBrain01Icon,
  ArrowDown01Icon,
  AudioWave01Icon,
  KeyboardIcon,
  Plug01Icon,
  Link04Icon,
  Settings02Icon,
  BookOpen01Icon,
  ClipboardIcon,
  RecordIcon,
  Books02Icon,
  Download04Icon,
  Tick02Icon,
  Video01Icon,
  Target02Icon,
  HardDriveIcon,
} from "@hugeicons/core-free-icons"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item"
import { Kbd } from "@/components/ui/kbd"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import type {
  CatalogModel,
  DictionarySuggestion,
  DictationStatus,
  KnowledgeState,
  KnownVoice,
  ModelListState,
  ModelProgress,
  NotionProgress,
  NotionSearchResult,
  NotionAuth,
  NotionStatus,
  OpenRouterModel,
  SettingsState,
  CoachMode,
  UpdateState,
  VoicesState,
  AiModelState,
  ConnectState,
  IntegrationKind,
  IntegrationState,
  IntegrationToolkit,
  KnowledgeSource,
} from "@/types/bridge"

import { useBridgeEvents } from "./events"
import { CloudflareSetup, useShareState } from "@/main-window/share"
import { DriveSection } from "@/drive/DriveSettings"

type SectionId = "general" | "clipboard" | "record" | "drive" | "dictionary" | "knowledge" | "transcription" | "dictation" | "zoom" | "coaching" | "notes" | "ai" | "connect" | "updates"

// Old links to "connections" open the merged Notes & connections page.
function sectionFor(requested: string): SectionId | null {
  const id = requested === "connections" ? "notes" : requested
  return SECTIONS.some((entry) => entry.id === id) ? (id as SectionId) : null
}

const SECTIONS: { id: SectionId; label: string; icon: typeof AudioWave01Icon }[] = [
  { id: "general", label: "General", icon: Settings02Icon },
  { id: "transcription", label: "Transcription", icon: AudioWave01Icon },
  { id: "dictation", label: "Dictation", icon: KeyboardIcon },
  { id: "dictionary", label: "Dictionary", icon: BookOpen01Icon },
  { id: "clipboard", label: "Clipboard", icon: ClipboardIcon },
  { id: "record", label: "Screen recording", icon: RecordIcon },
  { id: "drive", label: "Ember Drive", icon: HardDriveIcon },
  { id: "knowledge", label: "Knowledge base", icon: Books02Icon },
  { id: "zoom", label: "Meetings", icon: Video01Icon },
  { id: "coaching", label: "Coaching", icon: Target02Icon },
  { id: "notes", label: "Notes & connections", icon: Link04Icon },
  { id: "ai", label: "AI notes", icon: AiBrain01Icon },
  { id: "connect", label: "AI apps", icon: Plug01Icon },
  { id: "updates", label: "Updates", icon: Download04Icon },
]

export type Save = (update: Record<string, unknown>) => Promise<boolean>

function formatBytes(bytes: number) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`
}

// A part of a page, e.g. Notes and Connections on Notes & connections.
function SubHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-5 flex flex-col gap-1">
      <h3 className="text-[16px] font-semibold tracking-[-0.01em] text-foreground">{title}</h3>
      <p className="max-w-[600px] text-[13.5px] text-muted-foreground">{description}</p>
    </div>
  )
}

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <header className="flex flex-col gap-1.5 pb-6">
      <h1 className="text-[20px] font-semibold tracking-[-0.015em]">{title}</h1>
      <p className="max-w-[60ch] text-[13px] leading-5 text-muted-foreground">{description}</p>
    </header>
  )
}

/* Transcription */

const BUSY = new Set(["starting", "downloading", "installing", "finishing"])

export function ModelRow({
  model,
  progress,
  selected,
  onUse,
  onDownload,
  onCancel,
  onRemove,
}: {
  model: { label: string; meta: string; detail?: string; live: boolean }
  progress?: ModelProgress | null
  selected: boolean
  onUse?: () => void
  onDownload?: () => void
  onCancel?: () => void
  onRemove?: () => void
}) {
  const busy = progress ? BUSY.has(progress.state) : false
  const downloading = progress?.state === "downloading" && progress.total
  return (
    <Item className="relative items-start rounded-none border-0 border-b border-border py-4 pr-0 pl-5 last:border-b-0">
      {selected ? <span aria-hidden className="absolute top-[27px] left-0 block h-px w-3 bg-foreground" /> : null}
      <ItemContent className="gap-1">
        <ItemTitle className="flex items-center gap-2 text-[14px]">
          {model.label}
          <span className="text-[12px] font-normal text-faint">{model.live ? "Live" : "After the call"}</span>
          {selected ? (
            <span className="ml-1 text-[12px] font-medium text-foreground">In use</span>
          ) : null}
        </ItemTitle>
        <ItemDescription className="text-[12px]">{model.meta}</ItemDescription>
        {model.detail ? <p className="text-[12px] leading-[1.45] text-faint">{model.detail}</p> : null}
        {busy ? (
          <div className="mt-2 flex flex-col gap-1.5">
            <Progress value={Math.round((progress?.fraction || 0) * 100)} className={cn("h-1", !downloading && "opacity-60")} />
            <p className="tabular truncate text-[12px] text-muted-foreground">
              {downloading && progress?.received && progress.total
                ? `${Math.floor((progress.received / progress.total) * 100)}% · ${formatBytes(progress.received)} of ${formatBytes(progress.total)}`
                : progress?.message}
            </p>
          </div>
        ) : null}
        {progress?.state === "failed" ? <FieldError className="mt-1 text-[12px]">{progress.message}</FieldError> : null}
      </ItemContent>
      <ItemActions className="self-center">
        {busy ? (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : onDownload ? (
          <Button size="sm" onClick={onDownload}>
            {progress?.state === "failed" ? "Retry" : "Download"}
          </Button>
        ) : (
          <>
            {!selected && onUse ? (
              <Button size="sm" variant="secondary" onClick={onUse}>
                Use
              </Button>
            ) : null}
            {onRemove ? (
              <Button size="sm" variant="ghost" onClick={onRemove}>
                Remove
              </Button>
            ) : null}
          </>
        )}
      </ItemActions>
    </Item>
  )
}

function TranscriptionSection({ settings, save }: { settings: SettingsState; save: Save }) {
  const [models, setModels] = useState<ModelListState | null>(null)
  const [progress, setProgress] = useState<Record<string, ModelProgress>>({})
  const [removing, setRemoving] = useState<CatalogModel | null>(null)
  const [error, setError] = useState("")
  const [name, setName] = useState(settings.speakerName)

  useEffect(() => {
    void window.meetingRecorder.listModels().then(setModels)
  }, [])

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

  const run = async (action: () => Promise<unknown>) => {
    setError("")
    try {
      await action()
    } catch (failure) {
      setError((failure as Error).message)
    }
  }

  const others = models?.installed.filter((model) => !model.catalogId) || []

  return (
    <>
      <SectionHeader
        title="Transcription"
        description="Speech is transcribed on this Mac. Live models transcribe while people talk; Whisper models transcribe after the call ends."
      />
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="speaker-name">Your name</FieldLabel>
          <Input
            id="speaker-name"
            className="max-w-[320px]"
            value={name}
            maxLength={80}
            placeholder="Me"
            onChange={(event) => setName(event.target.value)}
            onBlur={() => name.trim() && name !== settings.speakerName && void save({ speakerName: name })}
            onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
          />
          <FieldDescription>Your microphone's speech is labelled with this name.</FieldDescription>
        </Field>
        <FieldSeparator />
        <FieldSet>
          <FieldTitle className="text-[14px]">Model</FieldTitle>
          <FieldDescription>
            Downloads come from Fermion Research and Hugging Face and are checked against pinned SHA-256 hashes.
          </FieldDescription>
          {error ? <FieldError>{error}</FieldError> : null}
          {!models ? (
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Spinner className="size-3.5" /> Checking installed models…
            </div>
          ) : (
            <ItemGroup className="gap-0 border-t border-border">
              {models.catalog.map((entry) => {
                const live = progress[entry.id] || entry.progress
                const installed = entry.installedModelId
                return (
                  <ModelRow
                    key={entry.id}
                    model={{
                      label: entry.label,
                      meta: `${entry.source} · ${entry.languages} · ${entry.sizeLabel}`,
                      detail: entry.detail,
                      live: entry.realtime,
                    }}
                    progress={live}
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
                    onRemove={installed ? () => setRemoving(entry) : undefined}
                  />
                )
              })}
            </ItemGroup>
          )}
          {others.length ? (
            <div className="mt-3 flex flex-col gap-2">
              <p className="text-[13px] font-medium text-muted-foreground">Also found on this Mac</p>
              <ItemGroup className="gap-0 border-t border-border">
                {others.map((model) => (
                  <ModelRow
                    key={model.id}
                    model={{ label: model.label, meta: model.path.replace(/^\/Users\/[^/]+/, "~"), detail: model.detail, live: model.realtime }}
                    selected={model.id === models?.selectedId}
                    onUse={() => run(async () => setModels(await window.meetingRecorder.selectModel(model.id)))}
                  />
                ))}
              </ItemGroup>
            </div>
          ) : null}
        </FieldSet>
      </FieldGroup>

      <AlertDialog open={Boolean(removing)} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              It frees {removing?.sizeLabel} on this Mac. You can download it again from this page.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => removing && run(async () => setModels(await window.meetingRecorder.removeModel(removing.id)))}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/* Dictation */

function DictationSection({ settings, save }: { settings: SettingsState; save: Save }) {
  const [status, setStatus] = useState<DictationStatus | null>(null)
  type Target = "dictationHotkey" | "askHotkey" | "commandHotkey" | "liveHelpHotkey"
  const [capturing, setCapturing] = useState<Target | null>(null)
  const [commandError, setCommandError] = useState("")
  const [liveError, setLiveError] = useState("")
  const [error, setError] = useState("")
  const [askError, setAskError] = useState("")

  useEffect(() => {
    void window.meetingRecorder.getDictationStatus().then(setStatus)
  }, [settings.dictationEnabled, settings.dictationHotkeyLabel])
  useBridgeEvents({ dictationStatus: setStatus })

  const capture = async (target: Target = "dictationHotkey") => {
    if (capturing) {
      await window.meetingRecorder.cancelHotkeyCapture()
      return
    }
    const setFailure =
      target === "askHotkey" ? setAskError : target === "commandHotkey" ? setCommandError : target === "liveHelpHotkey" ? setLiveError : setError
    setFailure("")
    setCapturing(target)
    try {
      const result = await window.meetingRecorder.captureHotkey()
      if (result) await save({ [target]: result.hotkey })
    } catch (failure) {
      setFailure((failure as Error).message)
    } finally {
      setCapturing(null)
    }
  }

  useEffect(() => {
    const cancel = () => capturing && void window.meetingRecorder.cancelHotkeyCapture()
    window.addEventListener("beforeunload", cancel)
    return () => window.removeEventListener("beforeunload", cancel)
  }, [capturing])

  const verb = settings.dictationMode === "toggle" ? "Press" : "Hold"
  const statusLine = !settings.dictationEnabled
    ? null
    : status?.tap === false
      ? { tone: "warn", text: "Ember needs Accessibility access to see the shortcut. Turn it on in System Settings, Privacy & Security, Accessibility." }
      : status?.running
        ? { tone: "ok", text: `Ready. ${verb} ${settings.dictationHotkeyLabel} and speak.` }
        : { tone: "", text: "Starting…" }

  return (
    <>
      <SectionHeader
        title="Dictation"
        description="Speak anywhere on your Mac. Your words are typed into the text field you're in, or copied to the clipboard when there isn't one. Esc cancels."
      />
      <FieldGroup>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="dictation-enabled">Dictate with a shortcut</FieldLabel>
            {statusLine ? (
              <FieldDescription className={cn(statusLine.tone === "warn" && "text-rec", statusLine.tone === "ok" && "text-foreground/80")}>
                {statusLine.text}
              </FieldDescription>
            ) : (
              <FieldDescription>Uses the transcription model you chose and keeps it loaded.</FieldDescription>
            )}
          </FieldContent>
          <Switch
            id="dictation-enabled"
            checked={settings.dictationEnabled}
            onCheckedChange={(checked) => void save({ dictationEnabled: checked })}
          />
        </Field>
        <FieldSeparator />
        <Field>
          <FieldLabel>Shortcut</FieldLabel>
          <div className="flex items-center gap-3">
            <Kbd
              className={cn(
                "h-9 min-w-[140px] justify-start px-3 text-[14px] text-foreground",
                capturing === "dictationHotkey" && "text-muted-foreground ring-2 ring-foreground/40",
              )}
            >
              {capturing === "dictationHotkey" ? "Press your shortcut…" : settings.dictationHotkeyLabel}
            </Kbd>
            <Button size="sm" variant="secondary" disabled={Boolean(capturing) && capturing !== "dictationHotkey"} onClick={() => void capture("dictationHotkey")}>
              {capturing === "dictationHotkey" ? "Cancel" : "Change…"}
            </Button>
          </div>
          {error ? <FieldError>{error}</FieldError> : null}
          <FieldDescription>
            Any key or combination works: fn, Right ⌥ ⌘ ⌃ ⇧ on their own, F-keys, Home, End, Page Up and Down, Ins, Del. To use fn alone, set
            System Settings, Keyboard, “Press Globe key to” to Do Nothing.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel>Mode</FieldLabel>
          <ToggleGroup
            type="single"
            variant="outline"
            value={settings.dictationMode}
            onValueChange={(value) => value && void save({ dictationMode: value })}
            className="justify-start"
          >
            <ToggleGroupItem value="hold" className="px-3 data-[state=on]:border-foreground/40 data-[state=on]:bg-foreground/10 data-[state=on]:text-foreground">
              Hold to talk
            </ToggleGroupItem>
            <ToggleGroupItem value="toggle" className="px-3 data-[state=on]:border-foreground/40 data-[state=on]:bg-foreground/10 data-[state=on]:text-foreground">
              Press to start and stop
            </ToggleGroupItem>
          </ToggleGroup>
        </Field>
        <Field>
          <FieldLabel>Clean up</FieldLabel>
          <ToggleGroup
            type="single"
            variant="outline"
            value={settings.dictationCleanup || "light"}
            onValueChange={(value) => value && void save({ dictationCleanup: value })}
            className="justify-start"
          >
            {[
              ["off", "Off"],
              ["light", "Light"],
              ["ai", "AI"],
            ].map(([value, label]) => (
              <ToggleGroupItem
                key={value}
                value={value}
                className="px-3 data-[state=on]:border-foreground/40 data-[state=on]:bg-foreground/10 data-[state=on]:text-foreground"
              >
                {label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <FieldDescription>
            {settings.dictationCleanup === "off"
              ? "Pastes exactly what was heard."
              : settings.dictationCleanup !== "ai"
                ? "Removes um, uh and stutters and fixes capitals, on this Mac."
                : settings.aiReady && settings.aiLocal
                  ? "Also applies your corrections and fixes punctuation with the on-device model, on this Mac. It's simpler than a cloud model; falls back to Light if it takes longer than 4 seconds."
                  : settings.aiReady
                    ? `Also applies your corrections (“Tuesday, no wait, Wednesday”) and fixes punctuation with ${settings.openRouterModel}. The text of each dictation is sent to OpenRouter, never the audio. Falls back to Light if it takes longer than 4 seconds.`
                    : "Needs an OpenRouter key or an on-device model in AI notes. Until then, dictation uses Light."}
          </FieldDescription>
        </Field>
        <DictationStyles settings={settings} save={save} />
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="keep-clipboard">Keep dictated text on the clipboard</FieldLabel>
            <FieldDescription>Otherwise your previous clipboard is put back after pasting.</FieldDescription>
          </FieldContent>
          <Switch
            id="keep-clipboard"
            checked={settings.dictationKeepOnClipboard}
            onCheckedChange={(checked) => void save({ dictationKeepOnClipboard: checked })}
          />
        </Field>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="dictation-whisper">Whisper mode</FieldLabel>
            <FieldDescription>
              For quiet offices and late nights: speak under your breath and your voice is boosted before it's transcribed. Leave it off in noisy
              rooms, where it can pick up background chatter.
            </FieldDescription>
          </FieldContent>
          <Switch id="dictation-whisper" checked={settings.dictationWhisper === true} onCheckedChange={(checked) => void save({ dictationWhisper: checked })} />
        </Field>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="dictation-history">Keep dictation history</FieldLabel>
            <FieldDescription>
              Saves what you dictate and rewrite by voice on this Mac, so you can find and copy it again under Dictation in the main window.
              Password fields are never saved.
            </FieldDescription>
          </FieldContent>
          <Switch id="dictation-history" checked={settings.dictationHistory !== false} onCheckedChange={(checked) => void save({ dictationHistory: checked })} />
        </Field>
        <FieldSeparator />
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="voice-ask">Ask your meetings by voice</FieldLabel>
            <FieldDescription>
              {verb} {settings.askHotkeyLabel || "the Ask shortcut"} anywhere and ask a question, like “what did Harry say about the video?”
              The answer appears above the pill with links to the calls it came from. Esc closes it.
            </FieldDescription>
          </FieldContent>
          <Switch id="voice-ask" checked={settings.voiceAskEnabled !== false} onCheckedChange={(checked) => void save({ voiceAskEnabled: checked })} />
        </Field>
        {settings.voiceAskEnabled !== false ? (
          <Field>
            <FieldLabel>Ask shortcut</FieldLabel>
            <div className="flex items-center gap-3">
              <Kbd
                className={cn(
                  "h-9 min-w-[140px] justify-start px-3 text-[14px] text-foreground",
                  capturing === "askHotkey" && "text-muted-foreground ring-2 ring-foreground/40",
                )}
              >
                {capturing === "askHotkey" ? "Press your shortcut…" : settings.askHotkeyLabel}
              </Kbd>
              <Button size="sm" variant="secondary" disabled={Boolean(capturing) && capturing !== "askHotkey"} onClick={() => void capture("askHotkey")}>
                {capturing === "askHotkey" ? "Cancel" : "Change…"}
              </Button>
            </div>
            {askError ? <FieldError>{askError}</FieldError> : null}
            <FieldDescription>Uses your OpenRouter model, which receives the notes and transcript passages it needs.</FieldDescription>
          </Field>
        ) : null}
        <FieldSeparator />
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="command-mode">Edit selected text by voice</FieldLabel>
            <FieldDescription>
              Select text in any app, {verb.toLowerCase()} {settings.commandHotkeyLabel || "the shortcut"} and say what to do: “make this
              shorter”, “turn this into bullets”, “translate to Spanish”. The selection is replaced with the result.
            </FieldDescription>
          </FieldContent>
          <Switch
            id="command-mode"
            checked={settings.commandModeEnabled !== false}
            onCheckedChange={(checked) => void save({ commandModeEnabled: checked })}
          />
        </Field>
        {settings.commandModeEnabled !== false ? (
          <Field>
            <FieldLabel>Edit shortcut</FieldLabel>
            <div className="flex items-center gap-3">
              <Kbd
                className={cn(
                  "h-9 min-w-[140px] justify-start px-3 text-[14px] text-foreground",
                  capturing === "commandHotkey" && "text-muted-foreground ring-2 ring-foreground/40",
                )}
              >
                {capturing === "commandHotkey" ? "Press your shortcut…" : settings.commandHotkeyLabel}
              </Kbd>
              <Button size="sm" variant="secondary" disabled={Boolean(capturing) && capturing !== "commandHotkey"} onClick={() => void capture("commandHotkey")}>
                {capturing === "commandHotkey" ? "Cancel" : "Change…"}
              </Button>
            </div>
            {commandError ? <FieldError>{commandError}</FieldError> : null}
            <FieldDescription>The selected text and your instruction are sent to your OpenRouter model. Esc cancels.</FieldDescription>
          </Field>
        ) : null}
        <FieldSeparator />
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="live-help">Live help during calls</FieldLabel>
            <FieldDescription>
              Press {settings.liveHelpHotkeyLabel || "the shortcut"} during a call and, without saying anything, get suggestions for what to say or
              ask next and anything to address, from the call so far and your knowledge base. Press again for fresh ones. Esc closes them.
            </FieldDescription>
          </FieldContent>
          <Switch id="live-help" checked={settings.liveHelpEnabled !== false} onCheckedChange={(checked) => void save({ liveHelpEnabled: checked })} />
        </Field>
        {settings.liveHelpEnabled !== false ? (
          <Field>
            <FieldLabel>Live help shortcut</FieldLabel>
            <div className="flex items-center gap-3">
              <Kbd
                className={cn(
                  "h-9 min-w-[140px] justify-start px-3 text-[14px] text-foreground",
                  capturing === "liveHelpHotkey" && "text-muted-foreground ring-2 ring-foreground/40",
                )}
              >
                {capturing === "liveHelpHotkey" ? "Press your shortcut…" : settings.liveHelpHotkeyLabel}
              </Kbd>
              <Button size="sm" variant="secondary" disabled={Boolean(capturing) && capturing !== "liveHelpHotkey"} onClick={() => void capture("liveHelpHotkey")}>
                {capturing === "liveHelpHotkey" ? "Cancel" : "Change…"}
              </Button>
            </div>
            {liveError ? <FieldError>{liveError}</FieldError> : null}
          </Field>
        ) : null}
      </FieldGroup>
    </>
  )
}

/* Clipboard */

// A shortcut with its Change… button, recorded the same way as the dictation shortcuts.
function ShortcutField({ label, value, setting, save }: { label: string; value?: string; setting: string; save: Save }) {
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState("")
  const capture = async () => {
    if (capturing) {
      await window.meetingRecorder.cancelHotkeyCapture()
      return
    }
    setError("")
    setCapturing(true)
    try {
      const result = await window.meetingRecorder.captureHotkey()
      if (result) await save({ [setting]: result.hotkey })
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setCapturing(false)
    }
  }
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <div className="flex items-center gap-3">
        <Kbd className={cn("h-9 min-w-[140px] justify-start px-3 text-[14px] text-foreground", capturing && "text-muted-foreground ring-2 ring-foreground/40")}>
          {capturing ? "Press your shortcut…" : value}
        </Kbd>
        <Button size="sm" variant="secondary" onClick={() => void capture()}>
          {capturing ? "Cancel" : "Change…"}
        </Button>
      </div>
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  )
}

const KEEP_OPTIONS = [
  { value: "1", label: "1 day" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "0", label: "Until I delete it" },
]

function SharingSettings() {
  const { state, refresh } = useShareState()
  const [confirm, setConfirm] = useState(false)
  if (!state) return <Spinner />
  if (!state.ready) return <CloudflareSetup state={state} onReady={() => void refresh()} />
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 rounded-xl border border-border bg-white/[0.02] px-4 py-3">
        <span className="size-2 rounded-full bg-emerald-400" />
        <span className="min-w-0 flex-1 text-[13.5px]">
          Ready{state.accountName ? ` on ${state.accountName}` : ""}
          <span className="block truncate font-mono text-[12px] text-faint">{state.url}</span>
        </span>
        <Button variant="ghost" size="sm" onClick={() => void window.meetingRecorder.shareSetup().then(() => refresh())}>
          Repair
        </Button>
      </div>
      {confirm ? (
        <div className="flex items-center gap-3 text-[13px] text-muted-foreground">
          Ember forgets this setup and the Cloudflare connection. Videos already shared keep working; delete them in Cloudflare (bucket ember-shares) if you want them gone.
          <Button variant="destructive" size="sm" className="shrink-0" onClick={() => void window.meetingRecorder.shareDisconnect().then(() => (setConfirm(false), refresh()))}>
            Disconnect
          </Button>
        </div>
      ) : (
        <button type="button" className="self-start text-[12.5px] text-faint hover:text-foreground" onClick={() => setConfirm(true)}>
          Disconnect Cloudflare
        </button>
      )}
    </div>
  )
}

function RecordSection({ settings, save }: { settings: SettingsState; save: Save }) {
  const enabled = settings.recordEnabled !== false
  return (
    <>
      <SectionHeader
        title="Screen recording"
        description="Record your screen, a window or an area with your camera and microphone. Recordings stay on this Mac, are transcribed here, and get a title, summary and chapters from your AI model."
      />
      <FieldGroup>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="record-enabled">Record shortcut</FieldLabel>
            <FieldDescription>
              Press {settings.recordHotkeyLabel || "the shortcut"} to set up a recording, again to start it, and again to stop and save it. You can also start one from
              Recordings or the menu bar.
            </FieldDescription>
          </FieldContent>
          <Switch id="record-enabled" checked={enabled} onCheckedChange={(checked) => void save({ recordEnabled: checked })} />
        </Field>
        {enabled ? <ShortcutField label="Record screen shortcut" value={settings.recordHotkeyLabel} setting="recordHotkey" save={save} /> : null}
        <FieldSeparator />
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="record-camera">Camera bubble</FieldLabel>
            <FieldDescription>Show your camera in a round bubble you can drag and resize. It's part of the recording. You can turn it off for each recording too.</FieldDescription>
          </FieldContent>
          <Switch id="record-camera" checked={settings.recordCamera !== false} onCheckedChange={(checked) => void save({ recordCamera: checked })} />
        </Field>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="record-countdown">Countdown</FieldLabel>
            <FieldDescription>Count 3, 2, 1 before recording starts. Click the countdown to start straight away.</FieldDescription>
          </FieldContent>
          <Switch id="record-countdown" checked={settings.recordCountdown !== false} onCheckedChange={(checked) => void save({ recordCountdown: checked })} />
        </Field>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="record-cursor">Smooth cursor</FieldLabel>
            <FieldDescription>
              Records without the system cursor and draws a smooth one in the editor instead, which you can restyle, resize or hide. Off: the cursor is part of the
              video.
            </FieldDescription>
          </FieldContent>
          <Switch id="record-cursor" checked={settings.recordHideCursor !== false} onCheckedChange={(checked) => void save({ recordHideCursor: checked })} />
        </Field>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="record-finish">Finish recordings automatically</FieldLabel>
            <FieldDescription>
              When a recording stops, Ember makes a finished version in your default style, with your webcam and cursor, so it's ready to share or copy without opening the
              editor.
            </FieldDescription>
          </FieldContent>
          <Switch id="record-finish" checked={settings.recordAutoFinish !== false} onCheckedChange={(checked) => void save({ recordAutoFinish: checked })} />
        </Field>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel>Recordings folder</FieldLabel>
            <FieldDescription>Where your recordings, their camera and sound files, and your edits are kept on this Mac.</FieldDescription>
          </FieldContent>
          <Button variant="pill" size="sm" onClick={() => void window.meetingRecorder.openRecordingsFolder()}>
            Show in Finder
          </Button>
        </Field>
      </FieldGroup>
      <div className="mt-10">
        <SubHeader
          title="Sharing"
          description="Share recordings as links that play from your own Cloudflare account: free up to 10 GB, and the videos never pass through anyone else."
        />
        <SharingSettings />
      </div>
    </>
  )
}

function ClipboardSection({ settings, save }: { settings: SettingsState; save: Save }) {
  const ignored = settings.clipboardIgnoreApps || []
  const [app, setApp] = useState("")
  const addApp = async () => {
    const name = app.trim()
    if (!name) return
    if (await save({ clipboardIgnoreApps: [...ignored.filter((entry) => entry.toLowerCase() !== name.toLowerCase()), name] })) setApp("")
  }
  return (
    <>
      <SectionHeader
        title="Clipboard"
        description="Grab text from anything on screen, keep everything you copy so you can paste it again, and save posts and pages from the web into boards."
      />
      <FieldGroup>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="saved-enabled">Save links</FieldLabel>
            <FieldDescription>
              Press {settings.saveHotkeyLabel || "the shortcut"} in Safari, Chrome, Arc, Brave or Edge to save the page you're on to Saved, or copy a link in any app
              and press it. macOS asks once per browser to let Ember read the page's address.
            </FieldDescription>
          </FieldContent>
          <Switch id="saved-enabled" checked={settings.savedEnabled !== false} onCheckedChange={(checked) => void save({ savedEnabled: checked })} />
        </Field>
        {settings.savedEnabled !== false ? <ShortcutField label="Save link shortcut" value={settings.saveHotkeyLabel} setting="saveHotkey" save={save} /> : null}
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="saved-ai">Summaries and tags</FieldLabel>
            <FieldDescription>
              Each saved page gets a one-line summary and a few tags from your AI model (the page's text goes to OpenRouter, or stays on this Mac in offline mode).
              {settings.aiReady ? "" : " Set up AI in AI notes first."}
            </FieldDescription>
          </FieldContent>
          <Switch id="saved-ai" disabled={!settings.aiReady} checked={settings.savedAi !== false && Boolean(settings.aiReady)} onCheckedChange={(checked) => void save({ savedAi: checked })} />
        </Field>
        <FieldSeparator />
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="grab-text">Grab text from screen</FieldLabel>
            <FieldDescription>
              Press {settings.grabHotkeyLabel || "the shortcut"} and drag over anything: a paused video, a screen share, a PDF, a photo. The text is
              read on this Mac and copied, ready to paste. QR codes and barcodes are read too. Press Space to pick a whole window, Esc to cancel.
            </FieldDescription>
          </FieldContent>
          <Switch id="grab-text" checked={settings.grabTextEnabled !== false} onCheckedChange={(checked) => void save({ grabTextEnabled: checked })} />
        </Field>
        {settings.grabTextEnabled !== false ? (
          <>
            <ShortcutField label="Grab text shortcut" value={settings.grabHotkeyLabel} setting="grabHotkey" save={save} />
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="grab-lines">Keep line breaks</FieldLabel>
                <FieldDescription>Off joins lines that wrap into paragraphs. On keeps every line as it was on screen, for code, lists and tables.</FieldDescription>
              </FieldContent>
              <Switch id="grab-lines" checked={Boolean(settings.grabKeepLineBreaks)} onCheckedChange={(checked) => void save({ grabKeepLineBreaks: checked })} />
            </Field>
          </>
        ) : null}
        <FieldSeparator />
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="clipboard-history">Clipboard history</FieldLabel>
            <FieldDescription>
              Keeps text, links, images and files you copy. Press {settings.clipboardHotkeyLabel || "the shortcut"} in any app to search them and paste one,
              or open the Clipboard page. Copies from password managers, and anything an app marks as secret, are never kept.
            </FieldDescription>
          </FieldContent>
          <Switch
            id="clipboard-history"
            checked={settings.clipboardHistoryEnabled !== false}
            onCheckedChange={(checked) => void save({ clipboardHistoryEnabled: checked })}
          />
        </Field>
        {settings.clipboardHistoryEnabled !== false ? (
          <>
            <ShortcutField label="Clipboard history shortcut" value={settings.clipboardHotkeyLabel} setting="clipboardHotkey" save={save} />
            <Field>
              <FieldLabel htmlFor="clipboard-keep">Keep copies for</FieldLabel>
              <div>
                <Select value={String(settings.clipboardKeepDays ?? 30)} onValueChange={(value) => void save({ clipboardKeepDays: Number(value) })}>
                  <SelectTrigger id="clipboard-keep" className="w-[200px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {KEEP_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <FieldDescription>Pinned items are kept until you remove them.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="clipboard-ignore">Never keep copies from</FieldLabel>
              <form
                className="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  void addApp()
                }}
              >
                <Input id="clipboard-ignore" value={app} placeholder="App name, e.g. Banking" className="w-[260px]" onChange={(event) => setApp(event.target.value)} />
                <Button type="submit" variant="secondary" disabled={!app.trim()}>
                  Add
                </Button>
              </form>
              {ignored.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {ignored.map((name) => (
                    <Badge key={name} variant="outline" className="h-6 gap-1 pr-1 font-normal">
                      {name}
                      <button
                        type="button"
                        aria-label={`Stop ignoring ${name}`}
                        className="rounded px-1 text-muted-foreground hover:text-foreground"
                        onClick={() => void save({ clipboardIgnoreApps: ignored.filter((entry) => entry !== name) })}
                      >
                        ×
                      </button>
                    </Badge>
                  ))}
                </div>
              ) : null}
              <FieldDescription>1Password, Bitwarden, Apple Passwords, Keychain Access and other password managers are always skipped.</FieldDescription>
            </Field>
          </>
        ) : null}
      </FieldGroup>
    </>
  )
}

/* Zoom */

/* Updates */

function UpdatesSection() {
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    void window.meetingRecorder.updateStatus().then(setUpdate)
  }, [])
  useBridgeEvents({ updateState: setUpdate })

  const check = async () => {
    setError("")
    try {
      setUpdate(await window.meetingRecorder.checkForUpdates())
    } catch (failure) {
      setError(cleanError(failure))
    }
  }
  const install = async () => {
    setError("")
    try {
      await window.meetingRecorder.installUpdate()
    } catch (failure) {
      setError(cleanError(failure))
    }
  }

  return (
    <>
      <SectionHeader
        title="Updates"
        description="Ember checks for new versions every few hours and downloads them in the background. An update installs only when you restart, never during a call."
      />
      <FieldGroup>
        <Field>
          <FieldLabel>Version</FieldLabel>
          {!update ? (
            <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Spinner className="size-3.5" /> Checking…
            </p>
          ) : update.state === "ready" ? (
            <div className="flex flex-col items-start gap-3">
              <p className="text-[13px] text-foreground/90">
                Ember {update.version} is ready. You're on {update.currentVersion}.
              </p>
              <Button onClick={() => void install()}>Restart to update</Button>
            </div>
          ) : update.state === "downloading" ? (
            <div className="flex max-w-[520px] flex-col gap-2">
              <p className="text-[13px] text-foreground/90">Downloading Ember {update.version}…</p>
              <Progress value={update.percent || 0} className="h-1" />
              <span className="tabular text-[12px] text-muted-foreground">{update.percent || 0}%</span>
            </div>
          ) : (
            <div className="flex flex-col items-start gap-3">
              <p className="flex items-center gap-2 text-[13px] text-foreground/90">
                Ember {update.currentVersion}
                {update.state === "up-to-date" ? <span className="text-muted-foreground">· up to date</span> : null}
                {update.state === "checking" ? <Spinner className="size-3.5" /> : null}
              </p>
              {update.state === "error" && update.error ? <p className="text-[12px] text-faint">{update.error}</p> : null}
              {update.supported ? (
                <Button size="sm" variant="secondary" disabled={update.state === "checking"} onClick={() => void check()}>
                  Check for updates
                </Button>
              ) : (
                <p className="text-[12px] text-faint">This is a development build, so it doesn't update itself.</p>
              )}
            </div>
          )}
          {error ? <FieldError>{error}</FieldError> : null}
        </Field>
      </FieldGroup>
    </>
  )
}

function cleanDeviceLabel(label: string) {
  return label.replace(/^Default - /, "").replace(/\s+\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, "").trim()
}

function sameDevice(a: string, b: string) {
  return cleanDeviceLabel(a).toLocaleLowerCase() === cleanDeviceLabel(b).toLocaleLowerCase()
}

// Lists audio inputs. Labels are hidden until the page has used the microphone once.
function useMicrophones() {
  const [inputs, setInputs] = useState<MediaDeviceInfo[] | null>(null)
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      let devices = await navigator.mediaDevices.enumerateDevices()
      if (devices.some((device) => device.kind === "audioinput" && !device.label)) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          stream.getTracks().forEach((track) => track.stop())
          devices = await navigator.mediaDevices.enumerateDevices()
        } catch {
          // Without microphone access only unnamed inputs are listed.
        }
      }
      if (!cancelled) setInputs(devices.filter((device) => device.kind === "audioinput"))
    }
    void load()
    navigator.mediaDevices.addEventListener("devicechange", load)
    return () => {
      cancelled = true
      navigator.mediaDevices.removeEventListener("devicechange", load)
    }
  }, [])
  return inputs
}

export function MicrophoneTest({ deviceId }: { deviceId: string | null }) {
  const [level, setLevel] = useState<number | null>(null)
  const [error, setError] = useState("")
  const stopRef = useRef<() => void>(() => {})

  useEffect(() => () => stopRef.current(), [])
  useEffect(() => {
    stopRef.current()
    setLevel(null)
  }, [deviceId])

  const start = async () => {
    setError("")
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), autoGainControl: true, noiseSuppression: true },
      })
      const context = new AudioContext()
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      context.createMediaStreamSource(stream).connect(analyser)
      const samples = new Float32Array(analyser.fftSize)
      let frame = 0
      let smooth = 0
      const draw = () => {
        analyser.getFloatTimeDomainData(samples)
        let energy = 0
        for (const sample of samples) energy += sample * sample
        const db = 20 * Math.log10(Math.max(Math.sqrt(energy / samples.length), 1e-5))
        const target = Math.min(1, Math.max(0, (db + 55) / 40))
        smooth += (target - smooth) * (target > smooth ? 0.5 : 0.12)
        setLevel(smooth)
        frame = requestAnimationFrame(draw)
      }
      draw()
      const timer = window.setTimeout(() => stopRef.current(), 15000)
      stopRef.current = () => {
        cancelAnimationFrame(frame)
        window.clearTimeout(timer)
        stream.getTracks().forEach((track) => track.stop())
        void context.close()
        setLevel(null)
        stopRef.current = () => {}
      }
    } catch (failure) {
      setError((failure as Error).message || "Couldn't open that microphone.")
    }
  }

  return (
    <div className="flex items-center gap-3">
      <Button size="sm" variant="secondary" onClick={() => (level === null ? void start() : stopRef.current())}>
        {level === null ? "Test" : "Stop"}
      </Button>
      {level !== null ? (
        <div className="flex flex-1 items-center gap-3">
          <Progress value={Math.round(level * 100)} className="h-1.5 flex-1 [&>[data-slot=progress-indicator]]:bg-live" aria-label="Microphone level" />
          <span className="w-[120px] text-[12px] text-muted-foreground">{level > 0.25 ? "Hearing you" : "Say something…"}</span>
        </div>
      ) : error ? (
        <FieldError>{error}</FieldError>
      ) : (
        <span className="text-[12px] text-muted-foreground">Check the level before a call.</span>
      )}
    </div>
  )
}

function MicrophoneField({ settings, save }: { settings: SettingsState; save: Save }) {
  const inputs = useMicrophones()
  const current = settings.microphoneLabel || "default"
  const systemDefault = inputs?.find((device) => device.deviceId === "default")
  const named = (inputs || []).filter((device) => device.deviceId !== "default" && device.deviceId !== "communications" && device.label)
  const connected = current === "default" || named.some((device) => sameDevice(device.label, current))
  const selectedDevice = current === "default" ? null : named.find((device) => sameDevice(device.label, current)) || null

  return (
    <Field>
      <FieldLabel htmlFor="microphone">Microphone</FieldLabel>
      <Select value={current} onValueChange={(value) => void save({ microphoneLabel: value })}>
        <SelectTrigger id="microphone" className="w-full max-w-[420px]">
          <SelectValue placeholder="Loading microphones…" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="default">
            System default{systemDefault?.label ? ` (${cleanDeviceLabel(systemDefault.label)})` : ""}
          </SelectItem>
          {named.map((device) => (
            <SelectItem key={device.deviceId} value={cleanDeviceLabel(device.label)}>
              {cleanDeviceLabel(device.label)}
            </SelectItem>
          ))}
          {!connected ? <SelectItem value={current}>{current} (not connected)</SelectItem> : null}
        </SelectContent>
      </Select>
      <FieldDescription>
        {connected
          ? "Used for your side of calls and for dictation. Everyone else in a call is recorded from your Mac's sound output."
          : `${current} isn't connected. Calls won't record until it's plugged back in or you choose another microphone.`}
      </FieldDescription>
      <MicrophoneTest deviceId={selectedDevice?.deviceId || null} />
    </Field>
  )
}

function GeneralSection({ settings, save }: { settings: SettingsState; save: Save }) {
  return (
    <>
      <SectionHeader title="General" description="Your microphone, and how Ember starts up." />
      <FieldGroup>
        <MicrophoneField settings={settings} save={save} />
        <FieldSeparator />
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="launch-at-login">Open at login</FieldLabel>
            <FieldDescription>
              Starts Ember when you log in to your Mac, waiting in the Dock and menu bar, so calls are recorded and your shortcuts work without
              opening it first. The window stays closed until you need it.
            </FieldDescription>
          </FieldContent>
          <Switch
            id="launch-at-login"
            checked={Boolean(settings.launchAtLogin)}
            onCheckedChange={(checked) => void save({ launchAtLogin: checked })}
          />
        </Field>
        {settings.loginItemStatus === "requires-approval" ? (
          <Field>
            <p className="text-[13px] text-ember">macOS needs your OK first: turn on Ember in System Settings → General → Login Items.</p>
            <div>
              <Button size="sm" variant="secondary" onClick={() => void window.meetingRecorder.openLoginItems()}>
                Open Login Items
              </Button>
            </div>
          </Field>
        ) : null}
      </FieldGroup>
    </>
  )
}

export function CalendarField({ settings, save }: { settings: SettingsState; save: Save }) {
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void window.meetingRecorder.calendarStatus().then(setStatus)
  }, [settings.calendarEnabled])
  const enabled = Boolean(settings.calendarEnabled) && status === "granted"
  const declined = status === "denied" || status === "restricted" || status === "write-only"

  return (
    <>
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor="calendar">Name calls from your calendar</FieldLabel>
        <FieldDescription>
          A call happening during a calendar event takes the event's name, and the note lists who was invited. Their names also help the AI
          spell them and are suggested when you name a speaker. Reads the Calendar app on this Mac, including Google and Outlook accounts added
          to it.
        </FieldDescription>
        {declined ? (
          <div className="flex items-center gap-3 pt-1">
            <FieldError>Calendar access is off for Ember.</FieldError>
            <Button size="sm" variant="secondary" onClick={() => void window.meetingRecorder.openCalendarPrivacy()}>
              Open System Settings
            </Button>
          </div>
        ) : null}
      </FieldContent>
      <Switch
        id="calendar"
        checked={enabled}
        disabled={busy}
        onCheckedChange={async (checked) => {
          if (!checked) return void save({ calendarEnabled: false })
          setBusy(true)
          try {
            const next = await window.meetingRecorder.connectCalendar()
            setStatus(next)
            if (next === "granted") await save({ calendarEnabled: true })
          } finally {
            setBusy(false)
          }
        }}
      />
    </Field>
    </>
  )
}

/** The briefing before a call: on or off. It needs the calendar to know who the call is with. */
export function PrepField({ settings, save }: { settings: SettingsState; save: Save }) {
  const calendar = Boolean(settings.calendarEnabled)
  const ai = Boolean(settings.aiReady)
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor="prep">Brief me before calls</FieldLabel>
        <FieldDescription>
          About two minutes before a call with people you've met before, a card shows what you last talked about and what's still open, with
          links to those calls. First calls stay quiet.
          {!calendar ? " Needs your calendar, to know who the call is with." : !ai ? " Needs AI: set it up in AI notes." : " Uses your AI model."}
        </FieldDescription>
      </FieldContent>
      <Switch
        id="prep"
        disabled={!calendar || !ai}
        checked={settings.prepEnabled !== false && calendar && ai}
        onCheckedChange={(checked) => void save({ prepEnabled: checked })}
      />
    </Field>
  )
}

function SpeakerSettings({ settings, save }: { settings: SettingsState; save: Save }) {
  const [state, setState] = useState<VoicesState | null>(null)
  const [confirm, setConfirm] = useState<KnownVoice | null>(null)
  useEffect(() => {
    void window.meetingRecorder.voicesState().then(setState)
    window.meetingRecorder.onVoicesState((next) => setState((current) => ({ ...current, ...next })))
  }, [])
  const enabled = settings.speakerSeparation !== false
  const voices = state?.voices || []

  return (
    <FieldGroup>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="speaker-separation">Tell speakers apart</FieldLabel>
          <FieldDescription>
            Labels the other people in a call Speaker 1, Speaker 2 and so on by their voice, on this Mac. Click a label on the Meetings page to
            name someone, and later calls name them too. Zoom calls also use the names Zoom shows.
          </FieldDescription>
          {enabled && state?.state === "downloading" ? (
            <div className="flex items-center gap-3 pt-1">
              <Progress value={Math.round(((state.received || 0) / (state.total || 1)) * 100)} className="h-1.5 max-w-[240px]" />
              <span className="text-[12px] text-muted-foreground">
                Downloading the voice model, {formatBytes(state.received || 0)} of {formatBytes(state.total || 0)}
              </span>
            </div>
          ) : null}
          {enabled && state?.state === "failed" ? (
            <div className="flex items-center gap-3 pt-1">
              <FieldError>The voice model couldn't download: {state.error}</FieldError>
              <Button size="sm" variant="secondary" onClick={() => void window.meetingRecorder.retryVoiceModel()}>
                Try again
              </Button>
            </div>
          ) : null}
        </FieldContent>
        <Switch id="speaker-separation" checked={enabled} onCheckedChange={(checked) => void save({ speakerSeparation: checked })} />
      </Field>
      {enabled ? (
        <>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor="learn-zoom">Learn voices from Zoom</FieldLabel>
              <FieldDescription>When Zoom shows who's speaking, remember that voice so Meet, Teams and Slack calls can name them.</FieldDescription>
            </FieldContent>
            <Switch id="learn-zoom" checked={settings.learnZoomVoices !== false} onCheckedChange={(checked) => void save({ learnZoomVoices: checked })} />
          </Field>
          <Field>
            <FieldTitle>Known voices</FieldTitle>
            {voices.length ? (
              <ItemGroup className="max-w-[460px] gap-1.5">
                {voices.map((voice) => (
                  <Item key={voice.id} variant="outline" size="sm">
                    <ItemContent>
                      <ItemTitle>{voice.name}</ItemTitle>
                      <ItemDescription>
                        {voice.seconds >= 60 ? `${Math.round(voice.seconds / 60)} min` : `${voice.seconds} s`} of speech heard
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setConfirm(voice)}>
                        Forget
                      </Button>
                    </ItemActions>
                  </Item>
                ))}
              </ItemGroup>
            ) : (
              <FieldDescription>None yet. Name a speaker on the Meetings page, or join a Zoom call.</FieldDescription>
            )}
            <FieldDescription>Voice prints are stored only on this Mac. They can't be turned back into audio.</FieldDescription>
          </Field>
        </>
      ) : null}
      <AlertDialog open={Boolean(confirm)} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Forget {confirm?.name}'s voice?</AlertDialogTitle>
            <AlertDialogDescription>Later calls will label them Speaker 1, 2… again. Past notes keep their name.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                if (!confirm) return
                const next = await window.meetingRecorder.forgetVoice(confirm.id)
                setState((current) => ({ ...(current || { state: "ready" }), voices: next }))
              }}
            >
              Forget
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </FieldGroup>
  )
}

const STYLE_GROUPS = [
  { id: "chat", label: "Chat apps", apps: "Slack, Messages, Discord, WhatsApp, Teams", default: "casual" },
  { id: "email", label: "Email", apps: "Mail, Outlook, Superhuman, Spark", default: "formal" },
  { id: "code", label: "Code and terminals", apps: "VS Code, Cursor, Xcode, Terminal, iTerm, Warp, Ghostty", default: "plain" },
] as const

const STYLE_LABELS: Record<string, string> = { casual: "Casual", formal: "Professional", plain: "Exactly as said", off: "No style" }

function DictationStyles({ settings, save }: { settings: SettingsState; save: Save }) {
  const rules = settings.dictationStyleRules || []
  const presets = settings.dictationStylePresets || {}
  const [apps, setApps] = useState<string[]>([])
  const [app, setApp] = useState("")
  const [style, setStyle] = useState("casual")
  const [custom, setCustom] = useState("")
  useEffect(() => {
    void window.meetingRecorder.installedApps().then(setApps).catch(() => setApps([]))
  }, [])
  const aiOn = settings.dictationCleanup === "ai" && settings.aiReady

  const add = async () => {
    const name = app.trim()
    const value = style === "custom" ? custom.trim() : style
    if (!name || !value) return
    const rest = rules.filter((rule) => rule.app.toLowerCase() !== name.toLowerCase())
    if (await save({ dictationStyleRules: [...rest, { app: name, style: value }] })) {
      setApp("")
      setCustom("")
    }
  }

  return (
    <Field>
      <FieldLabel>Style by app</FieldLabel>
      <FieldDescription>
        {aiOn
          ? "AI cleanup matches the app you're dictating into."
          : "Styles apply when Clean up is set to AI. In code editors and terminals, Light cleanup already leaves your capitalisation alone."}
      </FieldDescription>
      <ItemGroup className="max-w-[560px] gap-1.5">
        {STYLE_GROUPS.map((group) => (
          <Item key={group.id} variant="outline" size="sm">
            <ItemContent>
              <ItemTitle>{group.label}</ItemTitle>
              <ItemDescription>{group.apps}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Select
                value={presets[group.id] || group.default}
                onValueChange={(value) => void save({ dictationStylePresets: { ...presets, [group.id]: value } })}
              >
                <SelectTrigger size="sm" className="w-[160px]" aria-label={`${group.label} style`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(STYLE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </ItemActions>
          </Item>
        ))}
        {rules.map((rule) => (
          <Item key={rule.app} variant="outline" size="sm">
            <ItemContent>
              <ItemTitle>{rule.app}</ItemTitle>
              <ItemDescription>{STYLE_LABELS[rule.style] || `“${rule.style}”`}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => void save({ dictationStyleRules: rules.filter((candidate) => candidate.app !== rule.app) })}
              >
                Remove
              </Button>
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
      <form
        className="flex max-w-[560px] flex-wrap items-center gap-2 pt-1"
        onSubmit={(event) => {
          event.preventDefault()
          void add()
        }}
      >
        <Input list="installed-apps" value={app} placeholder="App, e.g. Linear" className="w-[180px]" onChange={(event) => setApp(event.target.value)} />
        <datalist id="installed-apps">
          {apps.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <Select value={style} onValueChange={setStyle}>
          <SelectTrigger className="w-[170px]" aria-label="Style">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="casual">Casual</SelectItem>
            <SelectItem value="formal">Professional</SelectItem>
            <SelectItem value="plain">Exactly as said</SelectItem>
            <SelectItem value="custom">My own words…</SelectItem>
          </SelectContent>
        </Select>
        {style === "custom" ? (
          <Input value={custom} placeholder="e.g. short, imperative, no full stops" className="min-w-[220px] flex-1" onChange={(event) => setCustom(event.target.value)} />
        ) : null}
        <Button type="submit" variant="secondary" disabled={!app.trim() || (style === "custom" && !custom.trim())}>
          Add app
        </Button>
      </form>
    </Field>
  )
}

function KnowledgeSection({ settings, save }: { settings: SettingsState; save: Save }) {
  const [state, setState] = useState<KnowledgeState | null>(null)
  const [folders, setFolders] = useState<string[]>(settings.knowledgeFolders || [])
  useEffect(() => {
    void window.meetingRecorder.knowledgeState().then((next) => {
      setState(next)
      if (next.folders) setFolders(next.folders)
    })
    window.meetingRecorder.onKnowledgeState((next) => setState((current) => ({ ...current, ...next })))
  }, [])
  const indexed = state?.indexedAt ? new Date(state.indexedAt) : null

  return (
    <>
      <SectionHeader
        title="Knowledge base"
        description="Folders of your own documents, like sales playbooks, call scripts, product notes or training transcripts. Ask, prep cards and live help during calls use them, and cite the file."
      />
      <FieldGroup>
        <Field>
          <FieldLabel>Folders</FieldLabel>
          {folders.length ? (
            <ItemGroup className="max-w-[560px] gap-1.5">
              {folders.map((folder) => (
                <Item key={folder} variant="outline" size="sm">
                  <ItemContent>
                    <ItemTitle className="truncate">{folder.split("/").pop()}</ItemTitle>
                    <ItemDescription className="truncate">{folder.replace(/^\/Users\/[^/]+/, "~")}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-muted-foreground"
                      onClick={async () => setFolders(await window.meetingRecorder.removeKnowledgeFolder(folder))}
                    >
                      Remove
                    </Button>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          ) : (
            <FieldDescription>No folders yet.</FieldDescription>
          )}
          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" variant={folders.length ? "secondary" : "default"} onClick={async () => setFolders(await window.meetingRecorder.addKnowledgeFolder())}>
              Add a folder…
            </Button>
            {folders.length ? (
              <Button size="sm" variant="ghost" disabled={state?.indexing} onClick={() => void window.meetingRecorder.reindexKnowledge()}>
                Read again
              </Button>
            ) : null}
          </div>
        </Field>
        {folders.length ? (
          <Field>
            <FieldTitle>Index</FieldTitle>
            {state?.indexing ? (
              <div className="flex items-center gap-3">
                <Progress value={state.total ? Math.round(((state.done || 0) / state.total) * 100) : 5} className="h-1.5 max-w-[240px]" />
                <span className="text-[12px] text-muted-foreground">Reading {state.total ? `${state.done} of ${state.total} files` : "your folders"}…</span>
              </div>
            ) : (
              <FieldDescription>
                {state?.files ?? 0} {state?.files === 1 ? "document" : "documents"}, {state?.passages ?? 0} passages
                {indexed ? `, read ${indexed.toLocaleDateString()} at ${indexed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}. Changes in these
                folders are picked up within a few seconds.
              </FieldDescription>
            )}
            {state?.errors?.length ? (
              <FieldDescription className="text-rec">
                Couldn't read {state.errors.length} {state.errors.length === 1 ? "file" : "files"}, e.g. {state.errors[0].file.split("/").pop()}: {state.errors[0].error}
              </FieldDescription>
            ) : null}
            <FieldDescription>
              Reads Markdown, text, PDF, Word, RTF, HTML and subtitle files. Everything is read and searched on this Mac; only the passages that
              match a question are sent to your OpenRouter model with it.
            </FieldDescription>
          </Field>
        ) : null}
        <FieldSeparator />
        <McpSourcesField />
        <FieldSeparator />
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="knowledge-enabled">Use in answers</FieldLabel>
            <FieldDescription>Ask, prep cards and live help draw on these documents and sources.</FieldDescription>
          </FieldContent>
          <Switch id="knowledge-enabled" checked={settings.knowledgeEnabled !== false} onCheckedChange={(checked) => void save({ knowledgeEnabled: checked })} />
        </Field>
      </FieldGroup>
    </>
  )
}

const errorMessage = (failure: unknown) =>
  String((failure as Error)?.message || failure).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")

/** MCP servers as knowledge sources: a docs search, a wiki, a CRM. */
function McpSourcesField() {
  const [sources, setSources] = useState<KnowledgeSource[]>([])
  const [adding, setAdding] = useState(false)
  const [kind, setKind] = useState<"command" | "url">("url")
  const [name, setName] = useState("")
  const [target, setTarget] = useState("")
  const [secret, setSecret] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [question, setQuestion] = useState("")
  const [results, setResults] = useState<{ name: string; text: string }[] | null>(null)
  const [testing, setTesting] = useState(false)
  const [signingIn, setSigningIn] = useState<string | null>(null)

  useEffect(() => {
    void window.meetingRecorder.knowledgeSources().then(setSources).catch(() => setSources([]))
  }, [])

  const change = async (action: () => Promise<KnowledgeSource[]>) => {
    setError("")
    try {
      setSources(await action())
      return true
    } catch (failure) {
      setError(errorMessage(failure))
      return false
    }
  }

  const add = async () => {
    setBusy(true)
    const ok = await change(() =>
      window.meetingRecorder.addKnowledgeSource(
        kind === "url" ? { name, kind, url: target, token: secret } : { name, kind, command: target, env: secret },
      ),
    )
    setBusy(false)
    if (ok) {
      setAdding(false)
      setName("")
      setTarget("")
      setSecret("")
    }
  }

  return (
    <Field>
      <FieldLabel>Connected sources</FieldLabel>
      <FieldDescription>
        MCP servers you already use, like your docs, wiki or CRM. Each question is also sent to their search tool, and what comes back is
        cited like a document. They get your question only, never the call transcript.
      </FieldDescription>
      {sources.length ? (
        <ItemGroup className="max-w-[600px] gap-1.5">
          {sources.map((source) => (
            <Item key={source.id} variant="outline" size="sm" className="items-start">
              <ItemContent className="min-w-0 gap-1.5">
                <ItemTitle>{source.name}</ItemTitle>
                <ItemDescription className="truncate font-mono text-[11px]">{source.target}</ItemDescription>
                <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
                  <span>Searches with</span>
                  <Select value={source.tool} onValueChange={(tool) => void change(() => window.meetingRecorder.updateKnowledgeSource(source.id, { tool }))}>
                    <SelectTrigger size="sm" className="h-7 w-auto min-w-[150px] font-mono text-[12px]" aria-label={`${source.name} search tool`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {source.tools.map((tool) => (
                        <SelectItem key={tool.name} value={tool.name} className="font-mono text-[12px]">
                          {tool.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {source.hasToken ? <span>· token saved</span> : null}
                  {source.signedIn && !source.needsSignIn ? <span>· signed in</span> : null}
                  {source.envKeys.length ? <span>· {source.envKeys.join(", ")}</span> : null}
                </div>
                {source.needsSignIn ? (
                  <div className="flex items-center gap-2">
                    <p className="text-[12px] text-rec">Signed out of {source.name}.</p>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-6 px-2 text-[12px]"
                      disabled={signingIn === source.id}
                      onClick={async () => {
                        setSigningIn(source.id)
                        await change(() => window.meetingRecorder.signInKnowledgeSource(source.id))
                        setSigningIn(null)
                      }}
                    >
                      {signingIn === source.id ? "Finish in your browser…" : "Sign in again"}
                    </Button>
                  </div>
                ) : source.lastError ? (
                  <p className="text-[12px] text-rec">Last try: {source.lastError}</p>
                ) : null}
              </ItemContent>
              <ItemActions className="flex-col items-end gap-2">
                <Switch
                  checked={source.enabled}
                  aria-label={`Use ${source.name}`}
                  onCheckedChange={(enabled) => void change(() => window.meetingRecorder.updateKnowledgeSource(source.id, { enabled }))}
                />
                <Button size="sm" variant="ghost" className="h-6 px-2 text-muted-foreground" onClick={() => void change(() => window.meetingRecorder.removeKnowledgeSource(source.id))}>
                  Remove
                </Button>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      ) : null}
      {adding ? (
        <form
          className="flex max-w-[600px] flex-col gap-2.5 rounded-lg border border-border p-3"
          onSubmit={(event) => {
            event.preventDefault()
            void add()
          }}
        >
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={kind}
            onValueChange={(value) => value && setKind(value as "command" | "url")}
            className="justify-start"
          >
            <ToggleGroupItem value="url" className="px-3 data-[state=on]:border-foreground/40 data-[state=on]:bg-foreground/10">
              Server URL
            </ToggleGroupItem>
            <ToggleGroupItem value="command" className="px-3 data-[state=on]:border-foreground/40 data-[state=on]:bg-foreground/10">
              Local command
            </ToggleGroupItem>
          </ToggleGroup>
          <Input value={name} placeholder="Name, e.g. Sales wiki (optional)" onChange={(event) => setName(event.target.value)} />
          <Input
            value={target}
            className="font-mono text-[13px]"
            placeholder={kind === "url" ? "https://example.com/mcp" : "npx -y @acme/docs-mcp"}
            aria-label={kind === "url" ? "Server URL" : "Command"}
            onChange={(event) => setTarget(event.target.value)}
          />
          {kind === "url" ? (
            <Input type="password" value={secret} placeholder="Access token (optional)" aria-label="Access token" onChange={(event) => setSecret(event.target.value)} />
          ) : (
            <Textarea
              value={secret}
              rows={2}
              className="min-h-[56px] font-mono text-[12px]"
              placeholder={"Environment, one per line (optional)\nAPI_KEY=…"}
              aria-label="Environment variables"
              onChange={(event) => setSecret(event.target.value)}
            />
          )}
          <FieldDescription>
            {kind === "url"
              ? "If the server asks you to sign in, your browser opens to do it. Otherwise paste an access token, or leave it empty."
              : "The same command you'd put in Claude's or Cursor's MCP settings. Tokens and values are kept in macOS secure storage."}
          </FieldDescription>
          {busy && kind === "url" ? (
            <FieldDescription className="text-foreground/80">If your browser opened, finish signing in there. This waits up to five minutes.</FieldDescription>
          ) : null}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || !target.trim()}>
              {busy ? "Connecting…" : "Connect"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="pt-1">
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
            Connect an MCP server…
          </Button>
        </div>
      )}
      {error ? <FieldError>{error}</FieldError> : null}
      {sources.some((source) => source.enabled) ? (
        <form
          className="flex max-w-[600px] flex-col gap-2 pt-2"
          onSubmit={async (event) => {
            event.preventDefault()
            setTesting(true)
            setResults(await window.meetingRecorder.testKnowledgeSources(question).catch(() => []))
            setTesting(false)
          }}
        >
          <div className="flex gap-2">
            <Input value={question} placeholder="Try a question, e.g. how do we handle pricing objections" onChange={(event) => setQuestion(event.target.value)} />
            <Button type="submit" size="sm" variant="secondary" disabled={testing || !question.trim()}>
              {testing ? "Asking…" : "Try"}
            </Button>
          </div>
          {results ? (
            results.length ? (
              results.map((result, index) => (
                <div key={index} className="rounded-md border border-border bg-panel px-3 py-2">
                  <p className="text-[12px] font-medium text-foreground">{result.name}</p>
                  <p className="line-clamp-4 text-[12px] whitespace-pre-wrap text-muted-foreground">{result.text}</p>
                </div>
              ))
            ) : (
              <FieldDescription>Nothing came back. A source that's still starting up is skipped; try again in a moment.</FieldDescription>
            )
          ) : null}
        </form>
      ) : null}
    </Field>
  )
}

function DictionarySection({ settings, save }: { settings: SettingsState; save: Save }) {
  const entries = settings.dictionary || []
  const [term, setTerm] = useState("")
  const [heardAs, setHeardAs] = useState("")
  const [voices, setVoices] = useState<string[]>([])
  const [suggestions, setSuggestions] = useState<DictionarySuggestion[]>([])
  useEffect(() => {
    void window.meetingRecorder.speakerNames().then(setVoices).catch(() => setVoices([]))
    const load = () => void window.meetingRecorder.dictionarySuggestions().then(setSuggestions).catch(() => setSuggestions([]))
    load()
    return window.meetingRecorder.onDictionarySuggestions(load)
  }, [])
  const answer = async (suggestion: DictionarySuggestion, accept: boolean) => {
    if (accept) {
      const rest = entries.filter((entry) => entry.term.toLowerCase() !== suggestion.term.toLowerCase())
      if (!(await save({ dictionary: [{ term: suggestion.term, heardAs: suggestion.heardAs }, ...rest] }))) return
    }
    setSuggestions((current) => current.filter((candidate) => candidate.term !== suggestion.term))
    await window.meetingRecorder.answerDictionarySuggestion(suggestion.term, accept).catch(() => false)
  }

  const add = async () => {
    const clean = term.trim()
    if (!clean) return
    const variants = heardAs.split(",").map((value) => value.trim()).filter(Boolean)
    const rest = entries.filter((entry) => entry.term.toLowerCase() !== clean.toLowerCase())
    if (await save({ dictionary: [{ term: clean, heardAs: variants }, ...rest] })) {
      setTerm("")
      setHeardAs("")
    }
  }

  return (
    <>
      <SectionHeader
        title="Dictionary"
        description="Names and words that speech recognition gets wrong. They're corrected in dictation and meeting transcripts, and the AI is told how to spell them."
      />
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="dictionary-term">Add a word or name</FieldLabel>
          <form
            className="flex flex-wrap items-start gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void add()
            }}
          >
            <Input id="dictionary-term" value={term} placeholder="e.g. Phonon" className="w-[200px]" onChange={(event) => setTerm(event.target.value)} />
            <Input
              aria-label="Often heard as"
              value={heardAs}
              placeholder="Often heard as, e.g. phone on, fonon"
              className="min-w-[240px] flex-1"
              onChange={(event) => setHeardAs(event.target.value)}
            />
            <Button type="submit" variant="secondary" disabled={!term.trim()}>
              Add
            </Button>
          </form>
          <FieldDescription>
            “Often heard as” is optional: list what you see instead, separated by commas. Each word is also capitalised the way you type it, so
            avoid everyday words like Will or May.
          </FieldDescription>
        </Field>
        {suggestions.length ? (
          <Field>
            <FieldTitle>Suggested from your calls</FieldTitle>
            <FieldDescription>Names the notes spotted that speech recognition seemed to get wrong. Add them to get them right next time.</FieldDescription>
            <ItemGroup className="max-w-[560px] gap-1.5">
              {suggestions.map((suggestion) => (
                <Item key={suggestion.term} variant="outline" size="sm">
                  <ItemContent>
                    <ItemTitle>{suggestion.term}</ItemTitle>
                    <ItemDescription>
                      Heard as {suggestion.heardAs.join(", ")}
                      {suggestion.meeting ? ` · ${suggestion.calls > 1 ? `${suggestion.calls} calls, last ` : ""}${suggestion.meeting}` : ""}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button size="sm" variant="secondary" onClick={() => void answer(suggestion, true)}>
                      Add
                    </Button>
                    <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => void answer(suggestion, false)}>
                      Dismiss
                    </Button>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          </Field>
        ) : null}
        {entries.length ? (
          <ItemGroup className="max-w-[560px] gap-1.5">
            {entries.map((entry) => (
              <Item key={entry.term} variant="outline" size="sm">
                <ItemContent>
                  <ItemTitle>{entry.term}</ItemTitle>
                  {entry.heardAs.length ? <ItemDescription>Fixes: {entry.heardAs.join(", ")}</ItemDescription> : null}
                </ItemContent>
                <ItemActions>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={() => void save({ dictionary: entries.filter((candidate) => candidate.term !== entry.term) })}
                  >
                    Remove
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        ) : null}
        <FieldSeparator />
        <SnippetsField settings={settings} save={save} />
        <FieldSeparator />
        <Field>
          <FieldTitle>Added for you</FieldTitle>
          <FieldDescription>
            {[settings.speakerName, ...voices].filter(Boolean).join(", ") || "Your name"}. Your own name and the voices you've named are always
            included.
          </FieldDescription>
        </Field>
      </FieldGroup>
    </>
  )
}

function SnippetsField({ settings, save }: { settings: SettingsState; save: Save }) {
  const snippets = settings.dictationSnippets || []
  const [trigger, setTrigger] = useState("")
  const [text, setText] = useState("")

  const add = async () => {
    const cleanTrigger = trigger.trim()
    if (!cleanTrigger || !text.trim()) return
    const rest = snippets.filter((snippet) => snippet.trigger.toLowerCase() !== cleanTrigger.toLowerCase())
    if (await save({ dictationSnippets: [{ trigger: cleanTrigger, text }, ...rest] })) {
      setTrigger("")
      setText("")
    }
  }

  return (
    <>
      <Field>
        <FieldLabel htmlFor="snippet-trigger">Snippets</FieldLabel>
        <FieldDescription>
          Say a short phrase and get the full text: “my calendar link” becomes your booking URL, “my address” your full address. Works in any
          dictation, exactly as you typed it here.
        </FieldDescription>
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void add()
          }}
        >
          <Input id="snippet-trigger" value={trigger} placeholder="When I say, e.g. my calendar link" className="max-w-[320px]" onChange={(event) => setTrigger(event.target.value)} />
          <div className="flex items-start gap-2">
            <Textarea
              aria-label="Type this instead"
              value={text}
              rows={2}
              placeholder="Type this instead, e.g. https://cal.com/you/30min"
              className="max-w-[480px] min-h-[60px] flex-1"
              onChange={(event) => setText(event.target.value)}
            />
            <Button type="submit" variant="secondary" disabled={!trigger.trim() || !text.trim()}>
              Add
            </Button>
          </div>
        </form>
      </Field>
      {snippets.length ? (
        <ItemGroup className="max-w-[560px] gap-1.5">
          {snippets.map((snippet) => (
            <Item key={snippet.trigger} variant="outline" size="sm">
              <ItemContent className="min-w-0">
                <ItemTitle>“{snippet.trigger}”</ItemTitle>
                <ItemDescription className="line-clamp-2 break-all">{snippet.text}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={() => void save({ dictationSnippets: snippets.filter((candidate) => candidate.trigger !== snippet.trigger) })}
                >
                  Remove
                </Button>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      ) : null}
    </>
  )
}

/* Connections: Linear, Notion, Google Drive (through Composio) and Apple Reminders */

function ChoicePicker({ kind, value, onChoose, placeholder, searchable }: {
  kind: IntegrationKind
  value: { id: string; name: string } | null
  onChoose: (choice: { id: string; name: string } | null) => Promise<void>
  placeholder: string
  searchable?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [options, setOptions] = useState<{ id: string; name: string }[] | null>(null)
  const [error, setError] = useState("")
  useEffect(() => {
    if (!open) return
    setError("")
    const timer = window.setTimeout(
      () =>
        void window.meetingRecorder
          .integrationOptions(kind, searchable ? query : "")
          .then(setOptions)
          .catch((failure) => setError(cleanError(failure))),
      searchable ? 250 : 0,
    )
    return () => window.clearTimeout(timer)
  }, [open, query, kind, searchable])
  return (
    <div className="flex flex-col gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="max-w-[360px] justify-between font-normal" role="combobox" aria-expanded={open}>
            <span className={cn("truncate", !value && "text-muted-foreground")}>{value?.name || placeholder}</span>
            <HugeiconsIcon icon={ArrowDown01Icon} className="text-muted-foreground" strokeWidth={1.8} />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[360px] p-0" align="start">
          <Command shouldFilter={!searchable}>
            <CommandInput placeholder="Search" value={query} onValueChange={setQuery} />
            <CommandList>
              <CommandEmpty>{error || (options ? "Nothing found." : "Loading…")}</CommandEmpty>
              <CommandGroup>
                {(options || []).map((option) => (
                  <CommandItem
                    key={option.id}
                    value={`${option.name} ${option.id}`}
                    onSelect={async () => {
                      setOpen(false)
                      await onChoose(option)
                    }}
                  >
                    <span className="truncate">{option.name}</span>
                    {option.id === value?.id ? <HugeiconsIcon icon={Tick02Icon} className="ml-auto size-4" strokeWidth={2} /> : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {error && !open ? <FieldError>{error}</FieldError> : null}
    </div>
  )
}

const CONNECTION_APPS: { toolkit: IntegrationToolkit; kind: IntegrationKind; label: string; does: string; pick: string; choiceKey: keyof IntegrationState; searchable?: boolean }[] = [
  { toolkit: "linear", kind: "linear", label: "Linear", does: "Send action items as Linear issues.", pick: "Choose a team", choiceKey: "linearTeam" },
  { toolkit: "notion", kind: "notion", label: "Notion", does: "Send action items as rows in a Notion task database.", pick: "Choose a database", choiceKey: "notionDatabase", searchable: true },
  { toolkit: "googledrive", kind: "googledrive", label: "Google Drive", does: "Save every call's notes as a Google Doc in a folder you choose.", pick: "Choose a folder", choiceKey: "driveFolder", searchable: true },
]

function ConnectionsSection() {
  const [state, setState] = useState<IntegrationState | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState("")
  const [error, setError] = useState("")
  useEffect(() => {
    const load = () => void window.meetingRecorder.integrations().then(setState).catch((failure) => setError(cleanError(failure)))
    load()
    window.meetingRecorder.onIntegrationsChanged(load)
    window.meetingRecorder.onIntegrationProgress((next) => setProgress(next.message || ""))
  }, [])
  const run = async (key: string, action: () => Promise<IntegrationState>) => {
    setBusy(key)
    setError("")
    setProgress("")
    try {
      setState(await action())
    } catch (failure) {
      setError(cleanError(failure))
    } finally {
      setBusy(null)
      setProgress("")
    }
  }
  const choose = (kind: IntegrationKind) => async (choice: { id: string; name: string } | null) => {
    await run(`choose-${kind}`, () => window.meetingRecorder.chooseIntegration(kind, choice))
  }
  const destinations = [
    state?.connected.linear && state.linearTeam ? { id: "linear", label: "Linear" } : null,
    state?.connected.notion && state.notionDatabase ? { id: "notion", label: "Notion" } : null,
    state?.remindersList ? { id: "reminders", label: "Reminders" } : null,
  ].filter(Boolean) as { id: string; label: string }[]
  const toggleClass = "px-4 data-[state=on]:border-foreground/40 data-[state=on]:bg-foreground/10 data-[state=on]:text-foreground"

  return (
    <>
      <FieldSeparator className="my-8" />
      <SubHeader
        title="Connections"
        description="Send action items to Linear, Notion or Reminders, and save your notes to Google Drive. Only what you send leaves your Mac."
      />
      <FieldGroup>
        <Field>
          <FieldLabel>Connect through</FieldLabel>
          <ToggleGroup
            type="single"
            variant="outline"
            value={state?.mode || "hosted"}
            onValueChange={(value) => value && void run("mode", () => window.meetingRecorder.setIntegrationMode(value as "hosted" | "personal"))}
            className="justify-start"
          >
            <ToggleGroupItem value="hosted" className={toggleClass}>
              Ember
            </ToggleGroupItem>
            <ToggleGroupItem value="personal" className={toggleClass}>
              My own Composio account
            </ToggleGroupItem>
          </ToggleGroup>
          <FieldDescription>
            {state?.mode === "personal"
              ? "Uses your Composio account and the Composio CLI. Connections stay in your account."
              : "No account needed: sign in to each app in your browser. Sign-ins are held by Composio, which Ember uses to reach these apps, and can only create issues, rows and docs."}
          </FieldDescription>
        </Field>
        <FieldSeparator />
        {CONNECTION_APPS.map((app) => {
          const connected = Boolean(state?.connected[app.toolkit])
          const working = busy === `connect-${app.toolkit}`
          return (
            <Field key={app.toolkit}>
              <div className="flex items-start justify-between gap-4">
                <FieldContent>
                  <FieldLabel>{app.label}</FieldLabel>
                  <FieldDescription>
                    {working && progress
                      ? progress
                      : app.toolkit === "googledrive" && connected && !state?.connected.googledocs
                        ? "Saving as plain-text Docs. Reconnect to add Google Docs for headings and lists."
                        : app.does}
                  </FieldDescription>
                </FieldContent>
                {working ? (
                  <Button size="sm" variant="ghost" onClick={() => void window.meetingRecorder.cancelIntegration()}>
                    Cancel
                  </Button>
                ) : connected ? (
                  <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => void run(`disconnect-${app.toolkit}`, () => window.meetingRecorder.disconnectIntegration(app.toolkit))}>
                    Disconnect
                  </Button>
                ) : (
                  <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => void run(`connect-${app.toolkit}`, () => window.meetingRecorder.connectIntegration(app.toolkit))}>
                    Connect…
                  </Button>
                )}
              </div>
              {connected ? (
                <ChoicePicker
                  kind={app.kind}
                  value={(state?.[app.choiceKey] as { id: string; name: string } | null) || null}
                  onChoose={choose(app.kind)}
                  placeholder={app.pick}
                  searchable={app.searchable}
                />
              ) : null}
            </Field>
          )
        })}
        <Field>
          <FieldLabel>Apple Reminders</FieldLabel>
          <FieldDescription>Send action items to a Reminders list on this Mac. Works offline.</FieldDescription>
          <ChoicePicker kind="reminders" value={state?.remindersList || null} onChoose={choose("reminders")} placeholder="Choose a list" />
        </Field>
        {error ? <FieldError>{error}</FieldError> : null}
        <FieldSeparator />
        <Field>
          <FieldLabel>After each call, send action items</FieldLabel>
          <div className="flex flex-wrap items-center gap-3">
            <ToggleGroup
              type="single"
              variant="outline"
              value={state?.autoSend || "off"}
              onValueChange={(value) =>
                value && void run("auto", () => window.meetingRecorder.setAutoSend({ autoSend: value as "off" | "mine" | "all", autoSendTo: state?.autoSendTo || destinations[0]?.id || "" }))
              }
              className="justify-start"
            >
              <ToggleGroupItem value="off" className={toggleClass}>
                Off
              </ToggleGroupItem>
              <ToggleGroupItem value="mine" className={toggleClass} disabled={!destinations.length}>
                Mine
              </ToggleGroupItem>
              <ToggleGroupItem value="all" className={toggleClass} disabled={!destinations.length}>
                Everyone's
              </ToggleGroupItem>
            </ToggleGroup>
            {state && state.autoSend !== "off" && destinations.length ? (
              <Select value={state.autoSendTo || destinations[0].id} onValueChange={(value) => void run("auto", () => window.meetingRecorder.setAutoSend({ autoSend: state.autoSend, autoSendTo: value }))}>
                <SelectTrigger size="sm" className="w-[160px]" aria-label="Send them to">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {destinations.map((destination) => (
                    <SelectItem key={destination.id} value={destination.id}>
                      to {destination.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>
          <FieldDescription>
            {destinations.length
              ? "You can also send any item yourself from the Action items page or a meeting."
              : "Connect an app and choose where items go first."}
          </FieldDescription>
        </Field>
      </FieldGroup>
    </>
  )
}

/* AI apps: the ember command and the MCP server */

function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex max-w-[600px] flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[12px] text-faint">{label}</span>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[12px] text-muted-foreground"
          onClick={async () => {
            await window.meetingRecorder.copyText(text)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1400)
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-md border border-border bg-panel px-3 py-2 font-mono text-[12px] leading-[1.5] whitespace-pre text-foreground/85" data-selectable>
        {text}
      </pre>
    </div>
  )
}

function ConnectSection() {
  const [state, setState] = useState<ConnectState | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState("")
  useEffect(() => {
    void window.meetingRecorder.connectState().then(setState).catch((failure) => setError(String(failure?.message || failure)))
  }, [])

  const run = async (key: string, action: () => Promise<ConnectState>) => {
    setBusy(key)
    setError("")
    try {
      setState(await action())
    } catch (failure) {
      setError(String((failure as Error)?.message || failure).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <SectionHeader
        title="AI apps"
        description="Let Claude, Cursor and other AI apps search your calls, action items and knowledge base, and use them from Terminal. They can only read: nothing is changed, and an app sees only what it asks for while you use it."
      />
      <FieldGroup>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel>Command line tool</FieldLabel>
            <FieldDescription>
              {state?.cli.installed
                ? `Installed at ${state.cli.path.replace(/^\/Users\/[^/]+/, "~")}.${state.cli.onPath ? " Try ember search pricing in Terminal." : " Add ~/.local/bin to your PATH to run it by name."}`
                : "Adds a ember command: search, list, show a call, list action items and search your knowledge base."}
            </FieldDescription>
          </FieldContent>
          <Button variant="secondary" size="sm" disabled={!state || busy === "cli"} onClick={() => void run("cli", () => window.meetingRecorder.installCli())}>
            {state?.cli.installed ? "Reinstall" : "Install"}
          </Button>
        </Field>
        {state?.cli.installed ? (
          <CopyBlock
            label="Examples"
            text={["ember search acme pricing", "ember list --from 2026-09-01", "ember actions --owner \"your name\"", "ember --help"].join("\n")}
          />
        ) : null}
        <FieldSeparator />
        {(state?.clients || []).map((client) => (
          <Field key={client.id} orientation="horizontal">
            <FieldContent>
              <FieldLabel>{client.label}</FieldLabel>
              <FieldDescription>
                {client.connected
                  ? `Connected. Restart ${client.label} if it was open, then ask it about your meetings.`
                  : client.installed
                    ? `Adds Ember to ${client.label}'s MCP servers. Your current settings file is kept as a backup.`
                    : `${client.label} isn't installed on this Mac.`}
              </FieldDescription>
            </FieldContent>
            <Button
              variant={client.connected ? "ghost" : "secondary"}
              size="sm"
              className={client.connected ? "text-muted-foreground" : ""}
              disabled={!client.installed || busy === client.id}
              onClick={() => void run(client.id, () => window.meetingRecorder.connectClient(client.id, !client.connected))}
            >
              {client.connected ? "Disconnect" : "Connect"}
            </Button>
          </Field>
        ))}
        {error ? <FieldError>{error}</FieldError> : null}
        {state ? (
          <>
            <FieldSeparator />
            <Field>
              <FieldTitle>Claude Code and other apps</FieldTitle>
              <FieldDescription>Run this once in Terminal for Claude Code. Other MCP apps take the JSON below in their settings.</FieldDescription>
            </Field>
            <CopyBlock label="Claude Code" text={state.snippets.claudeCode} />
            <CopyBlock label="MCP settings (JSON)" text={state.snippets.json} />
            <Field>
              <FieldTitle>What they can use</FieldTitle>
              <FieldDescription>
                search_meetings, list_meetings, get_meeting, get_action_items and search_knowledge. Whatever the app reads goes to that app's AI
                provider, like anything else you share with it.
              </FieldDescription>
            </Field>
          </>
        ) : null}
      </FieldGroup>
    </>
  )
}

function ZoomSection({ settings, save }: { settings: SettingsState; save: Save }) {
  return (
    <>
      <SectionHeader
        title="Meetings"
        description="Ember notices a call when a meeting app starts using your microphone. It never clicks or controls those apps."
      />
      <FieldGroup>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="auto-record">Record calls automatically</FieldLabel>
            <FieldDescription>
              Starts a few seconds after a call begins and stops when it ends. Pressing Stop pauses this until that call is over.
            </FieldDescription>
          </FieldContent>
          <Switch
            id="auto-record"
            checked={settings.autoRecordZoomMeetings}
            onCheckedChange={(checked) => void save({ autoRecordZoomMeetings: checked })}
          />
        </Field>
        <FieldSeparator />
        <Field>
          <FieldTitle>Works with</FieldTitle>
          <FieldDescription>
            Zoom, Microsoft Teams, Slack huddles, FaceTime, Webex, Discord, WhatsApp, Signal, Telegram, Tuple and Around. In a browser: Google
            Meet, Teams, Zoom, Whereby, Jitsi and Webex, when the meeting tab is showing as the call starts.
          </FieldDescription>
        </Field>
        <FieldSeparator />
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="shared-screens">Capture shared screens</FieldLabel>
            <FieldDescription>
              When someone shares slides or a document in a call, a picture of each new one is saved with its text, read on this Mac. The notes
              get a Shared on screen section, live help knows what's on screen, and the images go to Notion too when you use the Notion CLI.
              Images stay on this Mac; only their text goes to your OpenRouter model with the transcript.
            </FieldDescription>
          </FieldContent>
          <Switch id="shared-screens" checked={settings.captureSharedScreens !== false} onCheckedChange={(checked) => void save({ captureSharedScreens: checked })} />
        </Field>
        <FieldSeparator />
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="live-nudges">Tips during calls</FieldLabel>
            <FieldDescription>
              Now and then a short tip appears above the pill, only when it would help: a question you haven't answered, an objection your
              knowledge base covers, or something you promised last time. It goes away on its own, and never shows while you share your screen
              in Zoom. Uses your AI model (OpenRouter or the one on this Mac), which reads the latest part of the call.
            </FieldDescription>
          </FieldContent>
          <Switch
            id="live-nudges"
            checked={settings.liveNudges !== false && Boolean(settings.aiReady)}
            disabled={!settings.aiReady}
            onCheckedChange={(checked) => void save({ liveNudges: checked })}
          />
        </Field>
        {settings.liveNudges !== false && settings.aiReady ? (
          <Field>
            <FieldLabel>How often</FieldLabel>
            <ToggleGroup
              type="single"
              variant="outline"
              value={settings.liveNudgeFrequency || "normal"}
              onValueChange={(value) => value && void save({ liveNudgeFrequency: value })}
              className="justify-start"
            >
              {[
                ["rarely", "Rarely"],
                ["normal", "Sometimes"],
                ["often", "Often"],
              ].map(([value, label]) => (
                <ToggleGroupItem
                  key={value}
                  value={value}
                  className="px-4 data-[state=on]:border-foreground/40 data-[state=on]:bg-foreground/10 data-[state=on]:text-foreground"
                >
                  {label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <FieldDescription>
              How often the call is checked. Most checks find nothing worth a tip, and then nothing appears. You can also press Fewer tips on any
              tip.
            </FieldDescription>
          </Field>
        ) : null}
        <FieldSeparator />
        <PrepField settings={settings} save={save} />
        <FieldSeparator />
        <CalendarField settings={settings} save={save} />
        <FieldSeparator />
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="weekly-digest">Weekly digest</FieldLabel>
            <FieldDescription>
              On Fridays from 4 pm, sums up the week's calls: decisions, open action items, who you met. Find it under Weekly digest in the main
              window{settings.notesDestination !== "notion" ? ", and in a Weekly digests folder beside your notes" : ""}. Uses your OpenRouter model.
            </FieldDescription>
          </FieldContent>
          <Switch id="weekly-digest" checked={settings.weeklyDigest !== false} onCheckedChange={(checked) => void save({ weeklyDigest: checked })} />
        </Field>
      </FieldGroup>
      <FieldSeparator className="my-6" />
      <SpeakerSettings settings={settings} save={save} />
    </>
  )
}

/* Notes and Notion */

export const DESTINATION_HELP: Record<string, string> = {
  folder: "Each call becomes a Markdown note in your folder, next to its audio.",
  notion: "Each call becomes a page in your Notion database. Audio stays in your folder, and Ember keeps its own copy of the note for the Meetings page.",
  both: "Each call is saved as a Markdown note in your folder and as a page in Notion.",
}

const FRAMEWORK_CHOICES: [string, string][] = [
  ["auto", "Pick for each call"],
  ["discovery", "Discovery"],
  ["bant", "BANT"],
  ["meddic", "MEDDIC"],
  ["spin", "SPIN"],
  ["custom", "Your own checklist"],
  ["none", "Just the goal"],
]

/** Live coaching during calls: the coach's mode, goals and checklists, cues, and practice calls. */
function CoachingSection({ settings, save }: { settings: SettingsState; save: Save }) {
  const [modes, setModes] = useState<CoachMode[]>([])
  const [checklist, setChecklist] = useState(settings.coachChecklist || "")
  const [competitors, setCompetitors] = useState(settings.coachCompetitors || "")
  useEffect(() => {
    void window.meetingRecorder.coachModes().then(setModes).catch(() => {})
  }, [])
  const mode = settings.coachMode || "sales"
  const noKnowledge = !settings.knowledgeEnabled || !settings.knowledgeFolders?.length

  return (
    <>
      <SectionHeader title="Coaching" description="A coach on your calls: a goal and checklist for each one, quiet cues on how you're coming across, tips from your own playbooks, and a scorecard after." />
      <FieldGroup>
        {noKnowledge ? (
          <p className="rounded-lg border border-border bg-white/[0.02] px-4 py-3 text-[13px] text-muted-foreground">
            The coach draws on your knowledge base first: playbooks, objection handling, battlecards, pricing and process docs. Add a folder in Knowledge base so its goals,
            tips and reviews follow how you work.
          </p>
        ) : null}
        <Field>
          <FieldTitle>Coach as</FieldTitle>
          <div className="grid grid-cols-2 gap-2">
            {modes.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => void save({ coachMode: item.id })}
                className={cn(
                  "flex flex-col gap-0.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
                  mode === item.id ? "border-ember/60 bg-ember/[0.07]" : "border-border hover:bg-white/[0.03]",
                )}
                aria-pressed={mode === item.id}
              >
                <span className="text-[13.5px] font-medium text-foreground">{item.label}</span>
                <span className="text-[12px] leading-[1.4] text-muted-foreground">{item.description}</span>
              </button>
            ))}
          </div>
          <FieldDescription>Sets what tips look for, which cues show, the starting checklist and how calls are reviewed.</FieldDescription>
        </Field>
        <FieldSeparator />
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="call-goals">Goal and checklist for each call</FieldLabel>
            <FieldDescription>
              A goal is suggested from the calendar event, earlier calls with these people and your knowledge base; change it in the live view. The checklist ticks
              itself off as the call covers each point, and near the end of the calendar slot you're told what's still open. Uses your AI model.
            </FieldDescription>
          </FieldContent>
          <Switch id="call-goals" checked={settings.callGoals !== false && Boolean(settings.aiReady)} disabled={!settings.aiReady} onCheckedChange={(checked) => void save({ callGoals: checked })} />
        </Field>
        {settings.callGoals !== false ? (
          <Field>
            <FieldLabel>Checklist</FieldLabel>
            <Select value={settings.coachFramework || "auto"} onValueChange={(value) => void save({ coachFramework: value })}>
              <SelectTrigger className="w-[240px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FRAMEWORK_CHOICES.map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {settings.coachFramework === "custom" || ((settings.coachFramework || "auto") === "auto" && mode !== "sales" && mode !== "general") ? (
              <Textarea
                rows={5}
                value={checklist}
                onChange={(event) => setChecklist(event.target.value)}
                onBlur={() => void save({ coachChecklist: checklist })}
                placeholder={"One point per line, e.g.\nTheir current setup\nWho signs off\nBudget\nNext step with a date"}
              />
            ) : null}
            <FieldDescription>
              "Pick for each call" starts with your coach's usual checklist and lets the suggested goal choose a framework.{" "}
              {mode !== "sales" && mode !== "general" ? "Leave the box empty to use this coach's own list." : ""}
            </FieldDescription>
          </Field>
        ) : null}
        <FieldSeparator />
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="coach-cues">Cues on how you're coming across</FieldLabel>
            <FieldDescription>
              A few words on the coach chip when you've talked a long while, done most of the talking, sped up, used a lot of fillers, left their question hanging, gone a
              while without asking one, or their answers are getting short. Worked out on this Mac; nothing is sent anywhere.
            </FieldDescription>
          </FieldContent>
          <Switch id="coach-cues" checked={settings.coachCues !== false} onCheckedChange={(checked) => void save({ coachCues: checked })} />
        </Field>
        <FieldSeparator />
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="coach-chip">Coach chip</FieldLabel>
            <FieldDescription>A small pill at the top of the screen during calls with the goal, checklist progress and time left. Kept out of screen shares.</FieldDescription>
          </FieldContent>
          <Switch id="coach-chip" checked={settings.coachChip !== false} onCheckedChange={(checked) => void save({ coachChip: checked })} />
        </Field>
        <FieldSeparator />
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="knowledge-cues">Instant cards from your knowledge base</FieldLabel>
            <FieldDescription>
              When they mention pricing, a competitor, security, contract terms or a common objection, the matching passage from your knowledge base shows straight away.
              Found on this Mac without the AI.
            </FieldDescription>
          </FieldContent>
          <Switch id="knowledge-cues" checked={settings.knowledgeCues !== false} disabled={noKnowledge} onCheckedChange={(checked) => void save({ knowledgeCues: checked })} />
        </Field>
        {settings.knowledgeCues !== false && !noKnowledge ? (
          <Field>
            <FieldLabel htmlFor="competitors">Competitors to watch for</FieldLabel>
            <Input
              id="competitors"
              value={competitors}
              onChange={(event) => setCompetitors(event.target.value)}
              onBlur={() => void save({ coachCompetitors: competitors })}
              placeholder="Comma separated, e.g. Gong, Chorus"
            />
            <FieldDescription>Names from files with "competitor", "battlecard" or "vs" in their name are watched for too.</FieldDescription>
          </Field>
        ) : null}
        <FieldSeparator />
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="practice-voice">Practice partner speaks</FieldLabel>
            <FieldDescription>In Practice, the other side's lines are read out loud with the Mac's voice, so it feels like a call.</FieldDescription>
          </FieldContent>
          <Switch id="practice-voice" checked={settings.practiceVoice !== false} onCheckedChange={(checked) => void save({ practiceVoice: checked })} />
        </Field>
      </FieldGroup>
    </>
  )
}

function NotesSection({ settings, save }: { settings: SettingsState; save: Save }) {
  const destination = settings.notesDestination
  const usesNotion = destination !== "folder"
  return (
    <>
      <SectionHeader
        title="Notes & connections"
        description="Where each call's notes go, and the apps your action items and notes are sent to."
      />
      <SubHeader title="Notes" description="Recordings are always kept in your folder." />
      <FieldGroup>
        <Field>
          <FieldLabel>Save notes to</FieldLabel>
          <ToggleGroup
            type="single"
            variant="outline"
            value={destination}
            onValueChange={(value) => value && void save({ notesDestination: value })}
            className="justify-start"
          >
            {[
              ["folder", "Folder"],
              ["notion", "Notion"],
              ["both", "Both"],
            ].map(([value, label]) => (
              <ToggleGroupItem
                key={value}
                value={value}
                className="px-4 data-[state=on]:border-foreground/40 data-[state=on]:bg-foreground/10 data-[state=on]:text-foreground"
              >
                {label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <FieldDescription>{DESTINATION_HELP[destination]}</FieldDescription>
        </Field>
        <FieldSeparator />
        <Field>
          <FieldLabel htmlFor="notes-folder">{destination === "notion" ? "Recordings folder" : "Folder"}</FieldLabel>
          <div className="flex max-w-[520px] gap-2">
            <Input id="notes-folder" readOnly value={settings.notesDir.replace(/^\/Users\/[^/]+/, "~")} className="text-muted-foreground" />
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
          {destination === "notion" ? (
            <FieldDescription>Audio is kept here. If Notion can't be reached, the note is saved here too so nothing is lost.</FieldDescription>
          ) : null}
        </Field>
        {usesNotion ? (
          <>
            <FieldSeparator />
            <NotionPanel settings={settings} save={save} />
          </>
        ) : null}
      </FieldGroup>
    </>
  )
}

/* Notion connection */

const NOTION_BUSY = new Set(["downloading", "installing", "starting-login", "waiting"])

export function NotionPanel({ settings, save }: { settings: SettingsState; save: Save }) {
  const [status, setStatus] = useState<NotionStatus | null>(null)
  const [progress, setProgress] = useState<NotionProgress | null>(null)
  const [error, setError] = useState("")
  const [picking, setPicking] = useState(false)
  const [manual, setManual] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setStatus(await window.meetingRecorder.notionStatus())
    } catch (failure) {
      setError((failure as Error).message)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh, settings.notionDataSourceId])
  useBridgeEvents({ notionProgress: setProgress })

  const busy = progress ? NOTION_BUSY.has(progress.state) : Boolean(status?.busy)

  const connect = async (method: NotionAuth) => {
    setError("")
    try {
      const result = await window.meetingRecorder.notionConnect(method)
      await save({})
      setStatus(result.status)
      if (result.account && !result.status.database) setPicking(true)
    } catch (failure) {
      setError(cleanError(failure))
    } finally {
      setProgress(null)
    }
  }

  const choose = async (action: () => Promise<unknown>) => {
    setError("")
    try {
      await action()
      setPicking(false)
      await save({})
      await refresh()
    } catch (failure) {
      setError(cleanError(failure))
    }
  }

  return (
    <Field>
      <FieldLabel>Notion</FieldLabel>
      {busy && progress ? (
        <NotionProgressView progress={progress} />
      ) : !status ? (
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Spinner className="size-3.5" /> Checking your Notion connection…
        </p>
      ) : status.unavailable ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-[13px] text-muted-foreground">Notion isn't responding right now, so the connection can't be checked. Calls are still saved, and Notion saves retry automatically.</p>
          <Button size="sm" variant="secondary" onClick={() => void refresh()}>
            Try again
          </Button>
        </div>
      ) : !status.account ? (
        <div className="flex flex-col items-start gap-3">
          <p className="max-w-[56ch] text-[13px] leading-5 text-muted-foreground">
            Connect your Notion workspace and choose where calls go. Your browser opens to sign in; nothing to type.
            {!status.installed && status.method === "cli" ? " Ember first downloads the Notion CLI (5 MB) from Notion." : ""}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void connect("cli")}>Connect Notion</Button>
            <Button variant="secondary" onClick={() => void connect("composio")}>
              Log in to Notion via Composio
            </Button>
          </div>
          <p className="max-w-[56ch] text-[12px] leading-5 text-faint">
            Composio keeps the Notion connection in your Composio account. If the Composio CLI isn't installed yet, Ember downloads it (110 MB) from GitHub first.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="flex items-center gap-2 text-[13px] text-foreground/90">
            <span aria-hidden className="block h-px w-3 bg-foreground" />
            Connected as {status.account.name || status.account.email}
            {status.account.workspace ? <span className="text-muted-foreground">· {status.account.workspace}</span> : null}
            <span className="text-faint">· via {status.method === "composio" ? "Composio" : "Notion CLI"}</span>
          </p>
          {settings.notionDataSourceId && !picking ? (
            <div className="flex flex-col gap-2">
              <p className="text-[13px] text-muted-foreground">
                Saving calls to{" "}
                <span className="text-foreground">{status.database?.name || settings.notionDatabaseName || "your database"}</span>
              </p>
              {status.database?.error ? <p className="text-[12px] text-faint">{status.database.error}</p> : null}
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => setPicking(true)}>
                  Change database
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDisconnect(true)}>
                  Disconnect
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void connect(status.method === "composio" ? "cli" : "composio")}>
                  {status.method === "composio" ? "Use the Notion CLI instead" : "Use Composio instead"}
                </Button>
              </div>
            </div>
          ) : (
            <NotionDatabasePicker
              onUse={(database) => choose(() => window.meetingRecorder.notionUseDatabase(database))}
              onCreate={(pageId) => choose(() => window.meetingRecorder.notionCreateDatabase(pageId))}
              onCancel={settings.notionDataSourceId ? () => setPicking(false) : undefined}
            />
          )}
          {manual ? (
            <ManualDatabaseId settings={settings} onSave={(id) => choose(() => window.meetingRecorder.notionUseDatabase({ id, name: "" }))} />
          ) : (
            <button type="button" className="self-start text-[12px] text-faint underline-offset-4 hover:text-muted-foreground hover:underline" onClick={() => setManual(true)}>
              Enter a database ID instead
            </button>
          )}
        </div>
      )}
      {error ? <FieldError>{error}</FieldError> : null}

      <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Notion?</AlertDialogTitle>
            <AlertDialogDescription>
              New calls will be saved to your folder. Pages already in Notion stay where they are, and your {status?.method === "composio" ? "Composio" : "Notion CLI"} sign-in is left as it is.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep connected</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void choose(() => window.meetingRecorder.notionDisconnect())}>
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Field>
  )
}

export function cleanError(failure: unknown) {
  return String((failure as Error)?.message || failure).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")
}

function NotionProgressView({ progress }: { progress: NotionProgress }) {
  if (progress.state === "downloading" || progress.state === "installing") {
    const downloading = progress.state === "downloading" && progress.total
    return (
      <div className="flex max-w-[520px] flex-col gap-2">
        <p className="text-[13px] text-foreground/90">{progress.state === "installing" ? "Installing…" : progress.message || "Downloading…"}</p>
        <Progress value={Math.round((progress.fraction || 0) * 100)} className="h-1" />
        <div className="flex items-center justify-between">
          <span className="tabular text-[12px] text-muted-foreground">
            {downloading && progress.received != null && progress.total
              ? `${Math.floor((progress.received / progress.total) * 100)}% · ${formatBytes(progress.received)} of ${formatBytes(progress.total)}`
              : "Almost done"}
          </span>
          <Button size="sm" variant="ghost" onClick={() => void window.meetingRecorder.notionCancel()}>
            Cancel
          </Button>
        </div>
      </div>
    )
  }
  if (progress.state === "waiting") {
    return (
      <div className="flex max-w-[520px] flex-col gap-3">
        <p className="flex items-center gap-2 text-[13px] text-foreground/90">
          <Spinner className="size-3.5" /> {progress.message || "Finish signing in to Notion in your browser."}
        </p>
        {progress.code ? (
          <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
            Check the code matches <Kbd className="h-7 px-2 text-[13px] text-foreground">{progress.code}</Kbd>
          </p>
        ) : null}
        <div className="flex gap-2">
          {progress.url ? (
            <Button size="sm" variant="secondary" onClick={() => void window.meetingRecorder.openNote(progress.url!)}>
              Open the sign-in page again
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => void window.meetingRecorder.notionCancel()}>
            Cancel
          </Button>
        </div>
      </div>
    )
  }
  return (
    <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <Spinner className="size-3.5" /> {progress.message || "Opening Notion in your browser…"}
    </p>
  )
}

function NotionDatabasePicker({
  onUse,
  onCreate,
  onCancel,
}: {
  onUse: (database: { id: string; name: string }) => Promise<void>
  onCreate: (pageId: string) => Promise<void>
  onCancel?: () => void
}) {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<NotionSearchResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState("")
  const [working, setWorking] = useState("")
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let current = true
    setLoading(true)
    const timer = window.setTimeout(async () => {
      try {
        const next = await window.meetingRecorder.notionSearch(query)
        if (current) {
          setResults(next)
          setFailed("")
        }
      } catch (failure) {
        if (current) setFailed(cleanError(failure))
      } finally {
        if (current) setLoading(false)
      }
    }, query ? 250 : 0)
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [query, attempt])

  const run = async (label: string, action: () => Promise<void>) => {
    setWorking(label)
    try {
      await action()
    } finally {
      setWorking("")
    }
  }

  return (
    <div className="flex max-w-[560px] flex-col gap-2">
      <p className="text-[13px] text-muted-foreground">Choose where calls go: an existing database, or a page to create Call Transcripts in.</p>
      <Command shouldFilter={false} className="rounded-md border border-border">
        <CommandInput placeholder="Search your Notion pages and databases" value={query} onValueChange={setQuery} />
        <CommandList className="max-h-[240px]">
          {loading ? (
            <div className="flex items-center gap-2 px-3 py-3 text-[13px] text-muted-foreground">
              <Spinner className="size-3.5" /> Searching Notion…
            </div>
          ) : (
            <>
              {failed ? (
                <div className="flex flex-col items-center gap-3 px-4 py-6 text-center">
                  <p className="text-[13px] text-muted-foreground">{failed}</p>
                  <Button size="sm" variant="secondary" onClick={() => setAttempt((count) => count + 1)}>
                    Try again
                  </Button>
                </div>
              ) : (
                <CommandEmpty>Nothing found. Share a page with the Notion CLI in Notion, then search again.</CommandEmpty>
              )}
              {results?.databases.length ? (
                <CommandGroup heading="Use an existing database">
                  {results.databases.map((database) => (
                    <CommandItem
                      key={database.id}
                      value={`db-${database.id}`}
                      disabled={Boolean(working)}
                      onSelect={() => void run(database.id, () => onUse({ id: database.id, name: database.title }))}
                    >
                      <span className="min-w-0 flex-1 truncate">{database.title}</span>
                      {working === database.id ? <Spinner className="ml-auto size-3.5" /> : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
              {results?.pages.length ? (
                <CommandGroup heading="Create Call Transcripts in a page">
                  {results.pages.map((page) => (
                    <CommandItem
                      key={page.id}
                      value={`page-${page.id}`}
                      disabled={Boolean(working)}
                      onSelect={() => void run(page.id, () => onCreate(page.id))}
                    >
                      <span className="min-w-0 flex-1 truncate">{page.title}</span>
                      {working === page.id ? <Spinner className="ml-auto size-3.5" /> : <span className="ml-auto text-[12px] text-faint">Create here</span>}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
            </>
          )}
        </CommandList>
      </Command>
      {onCancel ? (
        <Button size="sm" variant="ghost" className="self-start" onClick={onCancel}>
          Keep the current database
        </Button>
      ) : null}
    </div>
  )
}

function ManualDatabaseId({ settings, onSave }: { settings: SettingsState; onSave: (id: string) => Promise<void> }) {
  const [value, setValue] = useState(settings.notionDataSourceId)
  return (
    <div className="flex max-w-[520px] gap-2">
      <Input
        className="tabular"
        value={value}
        autoComplete="off"
        placeholder="Database (data source) ID"
        onChange={(event) => setValue(event.target.value)}
      />
      <Button variant="secondary" disabled={!value.trim() || value.trim() === settings.notionDataSourceId} onClick={() => void onSave(value.trim())}>
        Use ID
      </Button>
    </div>
  )
}

/* AI notes */

/** Offline mode's models: download, pick and remove, with progress. */
function OnDeviceModels({ settings, save }: { settings: SettingsState; save: Save }) {
  const [state, setState] = useState<AiModelState | null>(null)
  const [progress, setProgress] = useState<Record<string, ModelProgress>>({})
  const [error, setError] = useState("")
  useEffect(() => {
    void window.meetingRecorder.aiModels().then(setState)
    window.meetingRecorder.onAiModelProgress((next) => setProgress((current) => ({ ...current, [next.id]: next })))
    window.meetingRecorder.onAiModelsChanged((next) => {
      setState(next)
      setProgress({})
      // Re-read whether AI is ready now that a model finished or was removed.
      void save({ localAiModelId: next.selectedId })
    })
  }, [save])
  const run = async (action: () => Promise<AiModelState>) => {
    setError("")
    try {
      setState(await action())
    } catch (failure) {
      setError(cleanError(failure))
    }
  }
  const selected = state?.models.find((model) => model.id === settings.localAiModelId)

  return (
    <Field>
      <FieldLabel>On-device model</FieldLabel>
      <ItemGroup className="max-w-[600px] gap-1.5">
        {(state?.models || []).map((model) => {
          const live = progress[model.id] || model.progress
          const busy = live && !["installed", "failed", "cancelled"].includes(live.state)
          const inUse = model.installed && model.id === settings.localAiModelId
          return (
            <Item key={model.id} variant="outline" size="sm" className={cn("items-start", inUse && "border-ember/50")}>
              <ItemContent className="min-w-0 gap-1">
                <ItemTitle className="flex items-center gap-2">
                  {model.label}
                  <span className="text-[12px] font-normal text-faint">{model.sizeLabel}</span>
                  {inUse ? <span className="text-[12px] font-normal text-ember">In use</span> : null}
                </ItemTitle>
                <ItemDescription>{model.detail}</ItemDescription>
                {busy ? (
                  <div className="flex flex-col gap-1 pt-1">
                    <Progress value={Math.round((live.fraction || 0) * 100)} className="h-1.5 [&>[data-slot=progress-indicator]]:bg-ember" />
                    <span className="text-[12px] text-muted-foreground">
                      {live.state === "downloading" && live.total
                        ? `${Math.round((live.fraction || 0) * 100)}% · ${Math.round((live.received || 0) / 1e6)} MB of ${Math.round(live.total / 1e6)} MB`
                        : live.message}
                    </span>
                  </div>
                ) : live?.state === "failed" ? (
                  <p className="text-[12px] text-rec">{live.message}</p>
                ) : null}
              </ItemContent>
              <ItemActions>
                {busy ? (
                  <Button size="sm" variant="ghost" onClick={() => void run(() => window.meetingRecorder.cancelAiModel(model.id))}>
                    Cancel
                  </Button>
                ) : model.installed ? (
                  <>
                    {!inUse ? (
                      <Button size="sm" variant="secondary" onClick={() => void save({ localAiModelId: model.id })}>
                        Use
                      </Button>
                    ) : null}
                    <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => void run(() => window.meetingRecorder.removeAiModel(model.id))}>
                      Remove
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    onClick={async () => {
                      await save({ localAiModelId: model.id })
                      await run(() => window.meetingRecorder.installAiModel(model.id))
                    }}
                  >
                    Download
                  </Button>
                )}
              </ItemActions>
            </Item>
          )
        })}
      </ItemGroup>
      {error ? <FieldError>{error}</FieldError> : null}
      <FieldDescription>
        {settings.aiReady
          ? `Ready. ${selected?.label || "The model"} loads when it's first needed and frees its memory after a few idle minutes.`
          : selected?.installed
            ? "Finishing setup…"
            : "Download a model to turn on AI notes, Ask, live help and tips offline. Until then they stay off; nothing is sent to the cloud."}
        {state && !state.runtime ? " The first download also installs a small MLX runtime (about 100 MB)." : ""}
        {" "}Runs with Apple's MLX on Apple Silicon. Gemma is made by Google; downloading it means accepting Google's Gemma terms.
      </FieldDescription>
    </Field>
  )
}

function NoteTemplateField({ settings, save }: { settings: SettingsState; save: Save }) {
  const [templates, setTemplates] = useState<{ id: string; label: string; sections: string[] }[]>([])
  useEffect(() => {
    void window.meetingRecorder.noteTemplates().then(setTemplates).catch(() => setTemplates([]))
  }, [])
  const current = templates.find((template) => template.id === settings.noteTemplate)
  return (
    <Field>
      <FieldLabel>Notes template</FieldLabel>
      <Select value={settings.noteTemplate || "auto"} onValueChange={(value) => void save({ noteTemplate: value })}>
        <SelectTrigger className="w-[220px]" aria-label="Notes template">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="auto">Auto, from the calendar title</SelectItem>
          {templates.map((template) => (
            <SelectItem key={template.id} value={template.id}>
              {template.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldDescription>
        {current?.sections.length
          ? `Adds ${current.sections.join(", ")} to every call's notes.`
          : current
            ? "Summary, decisions and action items."
            : "Sales calls, 1:1s, interviews and standups get their own sections, picked from the event's title (\"Acme demo\", \"Weekly 1:1\"…). Change it for one call from the live notes."}
      </FieldDescription>
    </Field>
  )
}

function AiSection({ settings, save }: { settings: SettingsState; save: Save }) {
  const [key, setKey] = useState("")
  const [models, setModels] = useState<OpenRouterModel[] | null>(null)
  const [loadError, setLoadError] = useState("")
  const [open, setOpen] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)

  useEffect(() => {
    window.meetingRecorder
      .getOpenRouterModels()
      .then(setModels)
      .catch((failure: Error) => setLoadError(failure.message))
  }, [])

  const current = models?.find((model) => model.id === settings.openRouterModel)
  const local = settings.aiProvider === "local"

  return (
    <>
      <SectionHeader
        title="AI notes"
        description={
          local
            ? "Notes, Ask, live help, tips, prep cards, digests and drafts run on a model on this Mac. Nothing leaves your Mac."
            : "Notes, Ask, live help, tips and the rest are written through OpenRouter. Transcript text leaves your Mac for these; audio never does."
        }
      />
      <FieldGroup>
        <Field>
          <FieldLabel>Where AI runs</FieldLabel>
          <ToggleGroup
            type="single"
            variant="outline"
            value={local ? "local" : "openrouter"}
            onValueChange={(value) => value && void save({ aiProvider: value })}
            className="justify-start"
          >
            {[
              ["openrouter", "OpenRouter"],
              ["local", "This Mac (offline)"],
            ].map(([value, label]) => (
              <ToggleGroupItem
                key={value}
                value={value}
                className="px-4 data-[state=on]:border-foreground/40 data-[state=on]:bg-foreground/10 data-[state=on]:text-foreground"
              >
                {label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <FieldDescription>
            {local
              ? "Private and free, and it works without internet. A small model is less thorough than a large cloud one: notes are shorter, and dictation cleanup is simpler."
              : "The most thorough notes, from any model you choose. You pay OpenRouter per use, usually pennies a call."}
          </FieldDescription>
        </Field>
        <FieldSeparator />
        {local ? <OnDeviceModels settings={settings} save={save} /> : null}
        {local ? <FieldSeparator /> : null}
        <NoteTemplateField settings={settings} save={save} />
      </FieldGroup>
      {!local ? (
      <FieldGroup className="mt-6">
        <Field>
          <FieldLabel htmlFor="openrouter-key">OpenRouter API key</FieldLabel>
          <div className="flex max-w-[520px] gap-2">
            <Input
              id="openrouter-key"
              type="password"
              autoComplete="off"
              value={key}
              placeholder={settings.hasOpenRouterKey ? "A key is saved" : "Paste a key"}
              onChange={(event) => setKey(event.target.value)}
            />
            <Button
              disabled={!key.trim()}
              onClick={async () => {
                if (await save({ openRouterKey: key })) setKey("")
              }}
            >
              Save key
            </Button>
            {settings.hasOpenRouterKey ? (
              <Button variant="ghost" onClick={() => setConfirmClear(true)}>
                Remove
              </Button>
            ) : null}
          </div>
          <FieldDescription>Encrypted with macOS secure storage and never shown again after saving.</FieldDescription>
        </Field>
        <FieldSeparator />
        <Field>
          <FieldLabel>Notes model</FieldLabel>
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" className="max-w-[520px] justify-between font-normal" role="combobox" aria-expanded={open}>
                <span className="truncate">{current ? `${current.name}` : settings.openRouterModel}</span>
                <HugeiconsIcon icon={ArrowDown01Icon} className="text-muted-foreground" strokeWidth={1.8} />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[520px] p-0" align="start">
              <Command>
                <CommandInput placeholder="Search provider or model, for example Anthropic" />
                <CommandList>
                  <CommandEmpty>{models ? "No matching models." : loadError || "Loading models…"}</CommandEmpty>
                  <CommandGroup>
                    {(models || []).map((model) => (
                      <CommandItem
                        key={model.id}
                        value={`${model.name} ${model.id}`}
                        onSelect={() => {
                          setOpen(false)
                          void save({ openRouterModel: model.id })
                        }}
                      >
                        <span className="truncate">{model.name}</span>
                        <span className="ml-auto truncate text-[12px] text-faint">{model.id}</span>
                        {model.id === settings.openRouterModel ? (
                          <HugeiconsIcon icon={Tick02Icon} className="size-4" strokeWidth={2} />
                        ) : null}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          <FieldDescription>
            {models ? `${models.length.toLocaleString()} models available.` : loadError || "Loading the OpenRouter catalog…"}
          </FieldDescription>
        </Field>
      </FieldGroup>
      ) : null}

      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the OpenRouter key?</AlertDialogTitle>
            <AlertDialogDescription>Notes won't be generated until you add a key again.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void save({ clearOpenRouterKey: true })}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/* Window */

export function App() {
  const [settings, setSettings] = useState<SettingsState | null>(null)
  const [section, setSection] = useState<SectionId>(() => {
    return sectionFor(window.location.hash.slice(1)) || "general"
  })
  useEffect(() => {
    window.meetingRecorder.onSettingsSection((requested) => {
      const id = sectionFor(requested)
      if (id) setSection(id)
    })
  }, [])
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null)

  useEffect(() => {
    void window.meetingRecorder.getSettings().then(setSettings)
    // Changed elsewhere, e.g. Fewer tips on a tip card.
    window.meetingRecorder.onSettingsChanged((next) => setSettings((current) => (current ? { ...current, ...next } : current)))
  }, [])

  const save = useCallback<Save>(async (update) => {
    try {
      const next = await window.meetingRecorder.saveSettings(update)
      setSettings((current) => (current ? { ...current, ...next } : next))
      setNotice({ tone: "ok", text: "Saved" })
      return true
    } catch (failure) {
      setNotice({ tone: "error", text: (failure as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") })
      return false
    }
  }, [])

  useEffect(() => {
    if (notice?.tone !== "ok") return
    const timer = window.setTimeout(() => setNotice(null), 1600)
    return () => window.clearTimeout(timer)
  }, [notice])

  const content = useMemo(() => {
    if (!settings) return null
    const props = { settings, save }
    switch (section) {
      case "general":
        return <GeneralSection {...props} />
      case "dictionary":
        return <DictionarySection {...props} />
      case "clipboard":
        return <ClipboardSection {...props} />
      case "record":
        return <RecordSection {...props} />
      case "drive":
        return <DriveSection {...props} />
      case "knowledge":
        return <KnowledgeSection {...props} />
      case "connect":
        return <ConnectSection />
      case "transcription":
        return <TranscriptionSection {...props} />
      case "dictation":
        return <DictationSection {...props} />
      case "zoom":
        return <ZoomSection {...props} />
      case "coaching":
        return <CoachingSection {...props} />
      case "notes":
        return (
          <>
            <NotesSection {...props} />
            <ConnectionsSection />
          </>
        )
      case "ai":
        return <AiSection {...props} />
      case "updates":
        return <UpdatesSection />
    }
  }, [section, settings, save])

  return (
    <SidebarProvider className="h-full min-h-0 bg-background">
      <Sidebar collapsible="none" className="m-2.5 mr-0 h-[calc(100%-20px)] w-[212px] rounded-[14px] border border-sidebar-border shadow-[0_8px_24px_rgb(0_0_0/0.25)]">
        <SidebarHeader className="drag h-[50px] shrink-0" />
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {SECTIONS.map((entry) => (
                  <SidebarMenuItem key={entry.id}>
                    <SidebarMenuButton isActive={section === entry.id} onClick={() => setSection(entry.id)}>
                      <HugeiconsIcon icon={entry.icon} strokeWidth={1.6} />
                      <span>{entry.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
      <SidebarInset className="flex h-full min-h-0 flex-col bg-background">
        <div className="drag flex h-12 shrink-0 items-center justify-end px-5">
          {notice ? (
            <span className={cn("no-drag text-[12px]", notice.tone === "error" ? "text-rec" : "text-muted-foreground")} role="status">
              {notice.text}
            </span>
          ) : null}
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="max-w-[680px] px-10 pt-2 pb-12">
            {content || (
              <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                <Spinner className="size-3.5" /> Loading settings…
              </div>
            )}
          </div>
        </ScrollArea>
      </SidebarInset>
    </SidebarProvider>
  )
}
