import { useCallback, useEffect, useMemo, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  AiBrain01Icon,
  ArrowDown01Icon,
  AudioWave01Icon,
  KeyboardIcon,
  NotionIcon,
  Settings02Icon,
  Download04Icon,
  Tick02Icon,
  Video01Icon,
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
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import type {
  CatalogModel,
  DictationStatus,
  ModelListState,
  ModelProgress,
  NotionProgress,
  NotionSearchResult,
  NotionAuth,
  NotionStatus,
  OpenRouterModel,
  SettingsState,
  UpdateState,
} from "@/types/bridge"

import { useBridgeEvents } from "./events"

type SectionId = "general" | "transcription" | "dictation" | "zoom" | "notes" | "ai" | "updates"

const SECTIONS: { id: SectionId; label: string; icon: typeof AudioWave01Icon }[] = [
  { id: "general", label: "General", icon: Settings02Icon },
  { id: "transcription", label: "Transcription", icon: AudioWave01Icon },
  { id: "dictation", label: "Dictation", icon: KeyboardIcon },
  { id: "zoom", label: "Zoom", icon: Video01Icon },
  { id: "notes", label: "Notes & Notion", icon: NotionIcon },
  { id: "ai", label: "AI notes", icon: AiBrain01Icon },
  { id: "updates", label: "Updates", icon: Download04Icon },
]

export type Save = (update: Record<string, unknown>) => Promise<boolean>

function formatBytes(bytes: number) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`
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
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    void window.meetingRecorder.getDictationStatus().then(setStatus)
  }, [settings.dictationEnabled, settings.dictationHotkeyLabel])
  useBridgeEvents({ dictationStatus: setStatus })

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
      setError((failure as Error).message)
    } finally {
      setCapturing(false)
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
      ? { tone: "warn", text: "Meeting Notes needs Accessibility access to see the shortcut. Turn it on in System Settings, Privacy & Security, Accessibility." }
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
            <Kbd className={cn("h-9 min-w-[140px] justify-start px-3 text-[14px] text-foreground", capturing && "text-muted-foreground ring-2 ring-foreground/40")}>
              {capturing ? "Press your shortcut…" : settings.dictationHotkeyLabel}
            </Kbd>
            <Button size="sm" variant="secondary" onClick={() => void capture()}>
              {capturing ? "Cancel" : "Change…"}
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
                : settings.hasOpenRouterKey
                  ? `Also applies your corrections (“Tuesday, no wait, Wednesday”) and fixes punctuation with ${settings.openRouterModel}. The text of each dictation is sent to OpenRouter, never the audio. Falls back to Light if it takes longer than 4 seconds.`
                  : "Needs an OpenRouter key in AI notes. Until then, dictation uses Light."}
          </FieldDescription>
        </Field>
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
        description="Meeting Notes checks for new versions every few hours and downloads them in the background. An update installs only when you restart, never during a call."
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
                Meeting Notes {update.version} is ready. You're on {update.currentVersion}.
              </p>
              <Button onClick={() => void install()}>Restart to update</Button>
            </div>
          ) : update.state === "downloading" ? (
            <div className="flex max-w-[520px] flex-col gap-2">
              <p className="text-[13px] text-foreground/90">Downloading Meeting Notes {update.version}…</p>
              <Progress value={update.percent || 0} className="h-1" />
              <span className="tabular text-[12px] text-muted-foreground">{update.percent || 0}%</span>
            </div>
          ) : (
            <div className="flex flex-col items-start gap-3">
              <p className="flex items-center gap-2 text-[13px] text-foreground/90">
                Meeting Notes {update.currentVersion}
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

function GeneralSection({ settings, save }: { settings: SettingsState; save: Save }) {
  return (
    <>
      <SectionHeader title="General" description="How Meeting Notes starts up." />
      <FieldGroup>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="launch-at-login">Open at login</FieldLabel>
            <FieldDescription>
              Starts Meeting Notes in the menu bar when you log in to your Mac, so Zoom calls and dictation work without opening it first. The
              window stays closed until you need it.
            </FieldDescription>
          </FieldContent>
          <Switch
            id="launch-at-login"
            checked={Boolean(settings.launchAtLogin)}
            onCheckedChange={(checked) => void save({ launchAtLogin: checked })}
          />
        </Field>
      </FieldGroup>
    </>
  )
}

function ZoomSection({ settings, save }: { settings: SettingsState; save: Save }) {
  return (
    <>
      <SectionHeader
        title="Zoom"
        description="Meeting Notes reads participant names and the active speaker from Zoom's window through Accessibility. It never clicks or controls Zoom."
      />
      <FieldGroup>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="auto-record">Record Zoom meetings automatically</FieldLabel>
            <FieldDescription>
              Starts when a meeting has someone in it and stops five seconds after it closes. Screen sharing stays in the same recording. Pressing Stop
              pauses this until that meeting ends.
            </FieldDescription>
          </FieldContent>
          <Switch
            id="auto-record"
            checked={settings.autoRecordZoomMeetings}
            onCheckedChange={(checked) => void save({ autoRecordZoomMeetings: checked })}
          />
        </Field>
      </FieldGroup>
    </>
  )
}

/* Notes and Notion */

export const DESTINATION_HELP: Record<string, string> = {
  folder: "Each call becomes a Markdown note in your folder, next to its audio.",
  notion: "Each call becomes a page in your Notion database. Audio stays in your folder, and Meeting Notes keeps its own copy of the note for the Meetings page.",
  both: "Each call is saved as a Markdown note in your folder and as a page in Notion.",
}

function NotesSection({ settings, save }: { settings: SettingsState; save: Save }) {
  const destination = settings.notesDestination
  const usesNotion = destination !== "folder"
  return (
    <>
      <SectionHeader
        title="Notes & Notion"
        description="Choose where each call's notes go. Recordings are always kept in your folder."
      />
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
            {!status.installed && status.method === "cli" ? " Meeting Notes first downloads the Notion CLI (5 MB) from Notion." : ""}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void connect("cli")}>Connect Notion</Button>
            <Button variant="secondary" onClick={() => void connect("composio")}>
              Log in to Notion via Composio
            </Button>
          </div>
          <p className="max-w-[56ch] text-[12px] leading-5 text-faint">
            Composio keeps the Notion connection in your Composio account. If the Composio CLI isn't installed yet, Meeting Notes downloads it (110 MB) from GitHub first.
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

  return (
    <>
      <SectionHeader
        title="AI notes"
        description="Notes are written through OpenRouter. The transcript text leaves your Mac for this step; audio never does."
      />
      <FieldGroup>
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
  const [section, setSection] = useState<SectionId>("general")
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null)

  useEffect(() => {
    void window.meetingRecorder.getSettings().then(setSettings)
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
      case "transcription":
        return <TranscriptionSection {...props} />
      case "dictation":
        return <DictationSection {...props} />
      case "zoom":
        return <ZoomSection {...props} />
      case "notes":
        return <NotesSection {...props} />
      case "ai":
        return <AiSection {...props} />
      case "updates":
        return <UpdatesSection />
    }
  }, [section, settings, save])

  return (
    <SidebarProvider className="h-full min-h-0">
      <Sidebar collapsible="none" className="h-full w-[212px] border-r border-sidebar-border">
        <SidebarHeader className="drag h-12 shrink-0" />
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
