import { useCallback, useEffect, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { CheckmarkCircle02Icon, Copy01Icon, Link01Icon, LinkSquare02Icon, Tick02Icon } from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import type { RecordingSummary, ShareOptions, ShareState } from "@/types/bridge"

const EXPIRY = [
  { days: 0, label: "Never" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
]

type Progress = { state: string; step?: string; message: string; url?: string | null }

export function useShareState() {
  const [state, setState] = useState<ShareState | null>(null)
  const refresh = useCallback(() => window.meetingRecorder.shareState().then(setState, () => {}), [])
  useEffect(() => {
    void refresh()
  }, [refresh])
  return { state, refresh, setState }
}

/** Connecting Cloudflare through Composio, then Ember sets up the rest. Used in Settings and the share dialog. */
export function CloudflareSetup({ state, onReady, compact = false }: { state: ShareState | null; onReady: () => void; compact?: boolean }) {
  const [progress, setProgress] = useState<Progress | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => window.meetingRecorder.onShareProgress(setProgress), [])

  const run = async (action: "connect" | "setup") => {
    setBusy(true)
    setProgress({ state: "working", message: action === "connect" ? "Opening Cloudflare and Composio…" : "Setting up…" })
    const reply = action === "connect" ? await window.meetingRecorder.shareConnect() : await window.meetingRecorder.shareSetup()
    setBusy(false)
    if ("error" in reply && reply.error) setProgress({ state: "failed", message: reply.error, url: reply.url })
    else onReady()
  }

  const failed = progress?.state === "failed"
  return (
    <div className="flex flex-col gap-4">
      {!compact ? (
        <ol className="flex flex-col gap-2.5 text-[13.5px] text-muted-foreground">
          {[
            "Connect Cloudflare through Composio. A card at the top right of your screen walks you through it: copy a key in Cloudflare, paste it into Composio.",
            "Ember makes a storage bucket and publishes your own share page, all in your Cloudflare account.",
            "Share links play from there. Free up to 10 GB of videos, and nobody else holds them.",
          ].map((text, index) => (
            <li key={index} className="flex gap-3">
              <span className="tabular flex size-5 shrink-0 items-center justify-center rounded-full bg-white/[0.07] text-[11.5px] text-foreground">{index + 1}</span>
              <span>{text}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {progress && (busy || failed) ? (
        <div className={cn("flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-[13.5px]", failed ? "border-rec/30 bg-rec/[0.06]" : "border-border bg-white/[0.02]")}>
          {failed ? null : <Spinner className="mt-0.5 shrink-0 text-ember" />}
          <span className={cn("flex-1", failed && "text-foreground")}>{progress.message}</span>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {busy ? (
          <Button variant="ghost" onClick={() => void window.meetingRecorder.shareCancel()}>
            Cancel
          </Button>
        ) : failed && progress?.url ? (
          <>
            <Button className="rounded-full" onClick={() => void window.meetingRecorder.shareOpenCloudflare(progress.url!)}>
              <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={1.8} /> Open Cloudflare
            </Button>
            <Button variant="pill" onClick={() => void run("setup")}>
              Try again
            </Button>
          </>
        ) : state?.connected ? (
          <Button className="rounded-full" onClick={() => void run("setup")}>
            {failed ? "Try again" : "Set up sharing"}
          </Button>
        ) : (
          <Button className="rounded-full" onClick={() => void run("connect")}>
            Connect Cloudflare
          </Button>
        )}
      </div>
      {!compact ? (
        <p className="text-[12px] text-faint">
          The Global API Key gives full access to your Cloudflare account and is kept by Composio. Ember only ever uses it to set up and update its own bucket and
          share page{state?.mode === "personal" ? ", through your own Composio account" : ""}. Videos upload straight to your share page.
        </p>
      ) : null}
    </div>
  )
}

export type ShareFormValue = Required<Omit<ShareOptions, "password" | "version">> & { password: string; removePassword: boolean }

/** The form's values as options to send: a password only when one was typed or removed. */
export function shareOptionsFrom(value: ShareFormValue): ShareOptions {
  return {
    expiresDays: value.expiresDays,
    download: value.download,
    transcript: value.transcript,
    ...(value.removePassword ? { password: "" } : value.password ? { password: value.password } : {}),
  }
}

export function daysLeftOf(expiresAt: string | null) {
  return daysLeft(expiresAt)
}

export function ShareOptionsForm({
  value,
  onChange,
  hasPassword,
  title,
  onTitleChange,
}: {
  value: Required<Omit<ShareOptions, "password" | "version">> & { password: string; removePassword: boolean }
  onChange: (value: Required<Omit<ShareOptions, "password" | "version">> & { password: string; removePassword: boolean }) => void
  hasPassword: boolean
  /** The video's title, shown on the share page: editable here when given. */
  title?: string
  onTitleChange?: (title: string) => void
}) {
  const set = (changes: Partial<typeof value>) => onChange({ ...value, ...changes })
  return (
    <div className="flex flex-col gap-4">
      {onTitleChange ? (
        <label className="flex flex-col gap-1.5">
          <span className="text-[13.5px]">Title</span>
          <Input value={title ?? ""} maxLength={200} placeholder="Name this video" onChange={(event) => onTitleChange(event.target.value)} />
        </label>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13.5px]">Link stops working</span>
        <div className="flex rounded-full border border-border p-0.5">
          {EXPIRY.map((option) => (
            <button
              key={option.days}
              type="button"
              onClick={() => set({ expiresDays: option.days })}
              className={cn("h-7 rounded-full px-3 text-[12.5px]", value.expiresDays === option.days ? "bg-white/[0.09] text-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="flex items-center justify-between text-[13.5px]">
          Password
          {hasPassword ? (
            <button type="button" className="text-[12px] text-faint hover:text-foreground" onClick={() => set({ removePassword: !value.removePassword, password: "" })}>
              {value.removePassword ? "Keep the password" : "Remove password"}
            </button>
          ) : null}
        </span>
        <Input
          type="password"
          value={value.password}
          disabled={value.removePassword}
          placeholder={value.removePassword ? "No password" : hasPassword ? "Has a password. Type to change it" : "Optional"}
          onChange={(event) => set({ password: event.target.value })}
        />
      </label>
      <label className="flex items-center justify-between text-[13.5px]">
        Allow download
        <Switch checked={value.download} onCheckedChange={(download) => set({ download })} />
      </label>
      <label className="flex items-center justify-between text-[13.5px]">
        <span>
          Show the transcript
          <span className="block text-[12px] text-faint">Also turns on captions</span>
        </span>
        <Switch checked={value.transcript} onCheckedChange={(transcript) => set({ transcript })} />
      </label>
    </div>
  )
}

function daysLeft(expiresAt: string | null) {
  if (!expiresAt) return 0
  const days = Math.round((Date.parse(expiresAt) - Date.now()) / 86400000)
  return days > 14 ? 30 : days > 0 ? 7 : 0
}

/** Share a recording as a link: set up Cloudflare if needed, choose options, upload, copy. */
export function ShareDialog({ recording, open, onOpenChange }: { recording: RecordingSummary; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { state, refresh } = useShareState()
  const share = recording.share
  const [options, setOptions] = useState({ expiresDays: 0, password: "", removePassword: false, download: false, transcript: true })
  const [upload, setUpload] = useState<{ state: string; value: number; url?: string; error?: string } | null>(null)
  const [error, setError] = useState("")
  const [copied, setCopied] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmStop, setConfirmStop] = useState(false)
  const [title, setTitle] = useState(recording.title)
  /** The title typed here becomes the recording's name, and the share page's title. */
  const saveTitle = async () => {
    const next = title.trim()
    if (next && next !== recording.title) await window.meetingRecorder.renameRecording(recording.id, next)
  }

  useEffect(() => {
    if (!open) return
    void refresh()
    setError("")
    setConfirmStop(false)
    setTitle(recording.title)
    setOptions({
      expiresDays: daysLeft(share?.expiresAt || null),
      password: "",
      removePassword: false,
      download: share?.download ?? false,
      transcript: share?.transcript ?? true,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, refresh, share?.expiresAt, share?.download, share?.transcript])

  useEffect(
    () =>
      window.meetingRecorder.onRecordingShare((progress) => {
        if (progress.id !== recording.id) return
        setUpload(progress.state === "done" ? null : progress)
        if (progress.state === "failed") setError(progress.error || "The upload failed.")
      }),
    [recording.id],
  )

  const asOptions = (): ShareOptions => ({
    expiresDays: options.expiresDays,
    download: options.download,
    transcript: options.transcript,
    ...(options.removePassword ? { password: "" } : options.password ? { password: options.password } : {}),
  })
  const start = async () => {
    setError("")
    setUpload({ state: "uploading", value: 0 })
    await saveTitle()
    const reply = await window.meetingRecorder.shareRecording(recording.id, asOptions())
    if ("error" in reply && reply.error) {
      setUpload(null)
      setError(reply.error)
    }
  }
  const save = async () => {
    setSaving(true)
    setError("")
    await saveTitle()
    const reply = await window.meetingRecorder.updateRecordingShare(recording.id, asOptions())
    setSaving(false)
    if ("error" in reply && reply.error) setError(reply.error)
    else setOptions((current) => ({ ...current, password: "", removePassword: false }))
  }
  const copy = async (url: string) => {
    await navigator.clipboard.writeText(url)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }
  const stop = async () => {
    const reply = await window.meetingRecorder.unshareRecording(recording.id)
    if ("error" in reply && reply.error) setError(reply.error)
    setConfirmStop(false)
  }

  const uploading = upload?.state === "uploading"
  const changed =
    share &&
    ((title.trim() && title.trim() !== recording.title) ||
      options.expiresDays !== daysLeft(share.expiresAt) || options.download !== share.download || options.transcript !== share.transcript || Boolean(options.password) || options.removePassword)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* min-w-0 on every row, so a long link shortens with … instead of pushing past the edge. */}
      <DialogContent className="gap-5 sm:max-w-[460px] [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[17px]">
            <HugeiconsIcon icon={Link01Icon} strokeWidth={1.8} className="size-[18px] text-ember" /> Share as a link
          </DialogTitle>
          <DialogDescription>
            {state && !state.ready
              ? "Links play from your own Cloudflare account. Set it up once."
              : "Shares the video as it plays here. Anyone with the link can watch; it isn't listed anywhere."}
          </DialogDescription>
        </DialogHeader>

        {state === null ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : !state.ready ? (
          <CloudflareSetup state={state} onReady={() => void refresh()} />
        ) : uploading || (upload && !share) ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 rounded-xl border border-border bg-white/[0.02] px-3 py-2.5">
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-muted-foreground">{upload?.url || "…"}</span>
              <span className="text-[12px] text-ember">Copied</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-[image:var(--ember-gradient)] transition-[width]" style={{ width: `${Math.round((upload?.value || 0) * 100)}%` }} />
            </div>
            <p className="flex justify-between text-[12.5px] text-muted-foreground">
              <span>Uploading. The link already works and shows the video when it's done.</span>
              <span className="tabular">{Math.round((upload?.value || 0) * 100)}%</span>
            </p>
            <Button variant="ghost" className="self-start" onClick={() => void window.meetingRecorder.cancelRecordingShare(recording.id)}>
              Cancel upload
            </Button>
          </div>
        ) : share ? (
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-2 rounded-xl border border-ember/30 bg-ember/[0.06] py-1.5 pr-1.5 pl-3">
              <HugeiconsIcon icon={CheckmarkCircle02Icon} strokeWidth={1.8} className="size-4 shrink-0 text-ember" />
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{share.url}</span>
              <Button variant="pill" size="sm" className="h-8" onClick={() => void copy(share.url)}>
                <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} strokeWidth={1.8} /> {copied ? "Copied" : "Copy"}
              </Button>
              <Button variant="ghost" size="icon-sm" title="Open" aria-label="Open the link" onClick={() => void window.meetingRecorder.openRecordingShare(recording.id)}>
                <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={1.8} />
              </Button>
            </div>
            {share.outdated ? (
              <div className="flex items-center gap-3 rounded-xl border border-border bg-white/[0.02] px-3.5 py-3 text-[13px]">
                <span className="flex-1 text-muted-foreground">There's a newer version since it was shared. Same link, new video?</span>
                <Button variant="pill" size="sm" className="h-8" onClick={() => void start()}>
                  Update video
                </Button>
              </div>
            ) : null}
            <ShareOptionsForm value={options} onChange={setOptions} hasPassword={share.hasPassword} title={title} onTitleChange={setTitle} />
            <div className="flex items-center gap-2">
              {confirmStop ? (
                <>
                  <span className="text-[13px] text-muted-foreground">The link stops working and the video is deleted from Cloudflare.</span>
                  <Button variant="destructive" size="sm" className="ml-auto h-8 shrink-0" onClick={() => void stop()}>
                    Stop sharing
                  </Button>
                </>
              ) : (
                <>
                  <button type="button" className="text-[12.5px] text-faint hover:text-rec" onClick={() => setConfirmStop(true)}>
                    Stop sharing
                  </button>
                  <Button className="ml-auto rounded-full" disabled={!changed || saving} onClick={() => void save()}>
                    {saving ? <Spinner /> : null} Save changes
                  </Button>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <ShareOptionsForm value={options} onChange={setOptions} hasPassword={false} title={title} onTitleChange={setTitle} />
            <Button className="h-10 rounded-full text-[14.5px]" onClick={() => void start()}>
              <HugeiconsIcon icon={Link01Icon} strokeWidth={1.8} /> Create link
            </Button>
            <p className="-mt-2 text-center text-[12px] text-faint">Uploads to {state.url?.replace(/^https:\/\//, "")}. The link is copied straight away.</p>
          </div>
        )}
        {error ? <p className="text-[13px] text-rec">{error}</p> : null}
      </DialogContent>
    </Dialog>
  )
}
