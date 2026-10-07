import { useCallback, useEffect, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon, CheckmarkCircle02Icon, Cancel01Icon, LinkSquare02Icon } from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { CloudflareSetup, useShareState } from "@/main-window/share"
import type { DriveCheck, DriveConfig, DriveProvider, DriveStatus, SettingsState } from "@/types/bridge"

import { CACHE_SIZES, PROVIDERS, bytesLabel, fieldsFor, labelFor, looksLikeMasterKey, placeholderFor, problemWith, regionsFor, stepsFor, type SetupField } from "./providers"

const isWindows = () => window.meetingRecorder.platform === "win32"

type Save = (update: Record<string, unknown>) => Promise<boolean>

const cleanError = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")

/** The drive's state, kept current. */
export function useDriveStatus() {
  const [status, setStatus] = useState<DriveStatus | null>(null)
  useEffect(() => {
    void window.meetingRecorder.driveStatus().then(setStatus)
    return window.meetingRecorder.onDriveStatus(setStatus)
  }, [])
  return status
}

function Header({ title, description }: { title: string; description: string }) {
  return (
    <header className="flex flex-col gap-1.5 pb-6">
      <h1 className="text-[20px] font-semibold tracking-[-0.015em]">{title}</h1>
      <p className="max-w-[60ch] text-[13px] leading-5 text-muted-foreground">{description}</p>
    </header>
  )
}

function SubHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-5 flex flex-col gap-1">
      <h3 className="text-[16px] font-semibold tracking-[-0.01em] text-foreground">{title}</h3>
      <p className="max-w-[600px] text-[13.5px] text-muted-foreground">{description}</p>
    </div>
  )
}

export function DriveSection({ settings, save }: { settings: SettingsState; save: Save }) {
  const status = useDriveStatus()
  const [changing, setChanging] = useState(false)
  if (!status) return <Spinner />
  if (!status.supported) {
    return (
      <>
        <Header title="Ember Drive" description={isWindows() ? "Your cloud storage in File Explorer." : "Your cloud storage as a drive in Finder."} />
        <p className="text-[13.5px] text-muted-foreground">{isWindows() ? "Ember Drive is unavailable on this Windows installation." : "Ember Drive needs macOS 26 or later."}</p>
      </>
    )
  }
  return (
    <>
      <Header
        title="Ember Drive"
        description={isWindows() ? "Your cloud storage in File Explorer. Files stream as you open them, changes upload in the background, and pinned files stay on this PC." : "Your cloud storage as a real drive in Finder. Files open straight away and stream as you use them, changes upload in the background, and anything you pin stays on this Mac."}
      />
      {isWindows() ? <SavedDriveAccounts status={status} /> : null}
      {status.configured && !changing ? (
        <>
          <DriveStatusCard status={status} onChange={() => setChanging(true)} />
          {status.ghostInstalled ? <RemoveGhost /> : null}
          <div className="mt-10">
            <SubHeader title="Search" description="Find any file on the drive by name, from anywhere." />
            <FieldGroup>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel>Quick search</FieldLabel>
                  <FieldDescription>
                    Press <Kbd>{isWindows() ? "Ctrl+Alt+O" : "⌃⌥O"}</Kbd>. {isWindows() ? "Enter shows the file in File Explorer, Alt+Enter copies a share link, Ctrl+Enter shares a video with Ember." : "Return shows the file in Finder, Option-Return copies a share link, Command-Return shares a video with Ember."}
                  </FieldDescription>
                </FieldContent>
                <Button variant="pill" size="sm" disabled={!status.mounted} onClick={() => void window.meetingRecorder.driveOpenSearch()}>
                  Open search
                </Button>
              </Field>
            </FieldGroup>
          </div>
          <div className="mt-10">
            <SubHeader title="Offline files" description={isWindows() ? "Pinned files download fully and stay available offline on this PC." : "Pinned files and folders download fully and stay on this Mac, and are kept up to date every 10 minutes."} />
            <OfflineFiles status={status} />
          </div>
          <div className="mt-10">
            <SubHeader title={isWindows() ? "On this PC" : "On this Mac"} description="Recently used file data stays here so reopening is instant." />
            <CacheSettings status={status} />
          </div>
          <div className="mt-10">
            <SubHeader title="Back up Ember" description="Keep copies of your recordings and notes in an Ember folder on the drive. New and changed ones are copied as they're made." />
            <Backups settings={settings} save={save} mounted={Boolean(status.mounted)} scan={status.backupScan} />
          </div>
        </>
      ) : (
        <DriveSetup status={status} onDone={() => setChanging(false)} onCancel={status.configured ? () => setChanging(false) : undefined} />
      )}
      {isWindows() ? <DriveConflicts key={`conflicts:${status.accountID || "default"}`} status={status} /> : null}
      {isWindows() ? <DriveRecovery key={status.accountID || "default"} mounted={Boolean(status.mounted)} /> : null}
    </>
  )
}

type RecoveryEntry = { id: string; type: "upload" | "folder" | "backup" | "move" | "pinned" | "pinned-copy" | "remote-copy" | "remote-remove" | "folder-move" | "delete"; local: string; started: number; directory?: boolean; hasCopies?: boolean }
type RecoveryList = { entries: RecoveryEntry[]; count: number }
const recoveryReason = (reason?: string) => {
  if (reason === "directory-delete-local-still-present") return "The cloud folder is empty and its recorded deletion is verified. The local folder is still present. Show it in File Explorer and retry deleting it to finish."
  if (reason === "directory-delete-copy-missing" || reason === "directory-delete-source-still-present") return "The folder deletion remains held. Retry deleting it in File Explorer; Ember checks that it is empty and verifies recovery copies before allowing deletion."
  if (reason?.startsWith("directory-delete-")) return "The recorded folder deletion cannot be confirmed. The local folder remains held."
  if (reason === "delete-local-file-still-present") return "The cloud deletion and recoverable trash copy are verified. The local file is still present. Show it in File Explorer and retry deleting it to finish."
  if (reason === "delete-copy-missing" || reason === "delete-source-still-present") return "The deletion remains held and the local file is preserved. Retry deleting it in File Explorer; Ember will verify the recoverable trash copy before allowing deletion."
  if (reason?.startsWith("delete-")) return "The recorded deletion cannot be confirmed. The local file remains held."
  if (reason === "pinned-source-changed-before-replacement") return "The offline file changed before replacement began. It remains held. Reveal the recorded copies to inspect them; this transfer cannot be finished automatically."
  if (reason === "folder-source-still-present" || reason === "folder-copy-missing") return "The folder move remains held. Finishing verifies each source and destination revision, completes missing copies and removes source files only after verifying their complete copied bytes."
  if (reason === "move-source-still-present") return "The original cloud file still exists. The move remains held. Finish verified move checks both copies and removes the original cloud file only if its revision and content match the recorded move."
  if (reason === "remote-content-differs") return "The cloud file has different content. Your local file is still held."
  if (reason === "remote-changed-during-check") return "The cloud file changed during the check. Check again when it is stable."
  if (reason?.startsWith("remote-") || reason === "folder-marker-missing-or-changed") return "The cloud copy could not be confirmed. The transfer remains held."
  if (reason?.includes("identity")) return "The local file now represents a different cloud file. It was preserved."
  if (reason === "missing-fingerprint") return "This transfer has no complete verification record. It remains held."
  return "The local file differs from the recorded transfer. It was preserved."
}
function DriveConflicts({ status }: { status: DriveStatus }) {
  const [page, setPage] = useState(0)
  const conflicts = status.conflicts || []
  const lastPage = Math.max(0, Math.ceil(conflicts.length / 20) - 1)
  const currentPage = Math.min(page, lastPage)
  if (!conflicts.length) return null
  return <div className="mt-10">
    <SubHeader title="Files needing attention" description="Ember reported these issues during its latest sync check." />
    <div className="divide-y divide-border rounded-xl border border-border">
      {conflicts.slice(currentPage * 20, currentPage * 20 + 20).map((conflict, index) => <div key={`${conflict.path}:${index}`} className="px-4 py-3">
        <p className="break-words text-[13px]" title={conflict.path}>{conflict.path}</p>
        <p className="mt-1 text-[12px] text-muted-foreground">{conflict.unfinishedUpload ? "An interrupted transfer protects this file. Check Recovery and saved copies below." : conflict.remoteMissing ? "This file is absent from the current cloud listing. Its local data is preserved." : conflict.localMissing ? "The cloud file has a recorded local path that is now missing. Ember has held it from downloading again." : conflict.localChanged && conflict.remoteChanged ? "Both the local file and its cloud revision changed. The local data is preserved." : conflict.localChanged ? "The local file has changes that have not been reconciled with the cloud." : conflict.remoteChanged ? "The cloud revision changed, but Ember could not install it. The current local data is preserved." : "Ember could not reconcile this file. Its local data is preserved."}</p>
      </div>)}
    </div>
    {conflicts.length > 20 ? <div className="mt-3 flex items-center gap-3"><Button variant="ghost" size="sm" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>Previous files</Button><span className="text-[12px] text-muted-foreground">{currentPage * 20 + 1}–{Math.min((currentPage + 1) * 20, conflicts.length)} of {conflicts.length}</span><Button variant="ghost" size="sm" disabled={currentPage >= lastPage} onClick={() => setPage(currentPage + 1)}>Next files</Button></div> : null}
  </div>
}

function DriveRecovery({ mounted }: { mounted: boolean }) {
  const [pending, setPending] = useState<RecoveryList>({ entries: [], count: 0 })
  const [finishable, setFinishable] = useState<string[]>([])
  const [restoreable, setRestoreable] = useState<string[]>([])
  const [confirmRestore, setConfirmRestore] = useState<RecoveryEntry | null>(null)
  const [confirmFinish, setConfirmFinish] = useState<RecoveryEntry | null>(null)
  const [confirmRemoval, setConfirmRemoval] = useState<RecoveryEntry | null>(null)
  const confirmationRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!confirmFinish && !confirmRemoval && !confirmRestore) return
    confirmationRef.current?.scrollIntoView({ block: "center" })
    confirmationRef.current?.focus({ preventScroll: true })
  }, [confirmFinish, confirmRemoval, confirmRestore])
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [page, setPage] = useState(0)
  const sequence = useRef(0)
  const refresh = useCallback(async () => {
    const request = ++sequence.current
    const result = await window.meetingRecorder.driveRequest<RecoveryList>("recover", { list: true, offset: page * 50, limit: 50 })
    if (request !== sequence.current) return
    setPending(result)
    if (page && page * 50 >= result.count) setPage(Math.max(0, Math.ceil(result.count / 50) - 1))
  }, [page])
  useEffect(() => { const load = () => void refresh().catch(failure => setError(cleanError(failure))); load(); const timer = setInterval(load, 15000); return () => { clearInterval(timer); sequence.current++ } }, [refresh, mounted])
  const check = async (entry: RecoveryEntry, finish = false, restore = false) => {
    setBusy(entry.id); setError(""); setMessage(""); setConfirmFinish(null); setConfirmRemoval(null); setConfirmRestore(null)
    try {
      const command = entry.type === "backup" ? "recoverBackup" : entry.type === "folder" ? "recoverFolder" : "recover"
      const result = await window.meetingRecorder.driveRequest<{ resolved: boolean; reason?: string; localCopiesPreserved?: boolean }>(command, { id: entry.id, kind: entry.type, finish, ...(restore ? { restore: true } : {}) })
      setFinishable(current => (entry.type === "folder-move" && ["folder-source-still-present", "folder-copy-missing"].includes(result.reason || "")) || result.reason === "move-source-still-present" || entry.type === "pinned" && ["local-changed", "pinned-original-restored", "pinned-original-restoration-held"].includes(result.reason || "") ? [...new Set([...current, entry.id])] : current.filter(id => id !== entry.id))
      setRestoreable(current => entry.type === "pinned" && ["local-changed", "pinned-original-restoration-held"].includes(result.reason || "") ? [...new Set([...current, entry.id])] : current.filter(id => id !== entry.id))
      setMessage(result.resolved ? result.localCopiesPreserved ? "The downloaded revision is installed. The original offline file and the local file before finishing are saved below." : "The recorded transfer was verified and its hold was cleared." : entry.type === "pinned" && result.reason === "local-changed" ? "The local file differs from the downloaded revision. Finish downloaded update saves the current local bytes before installing the recorded cloud revision." : result.reason === "pinned-original-restored" ? "The original offline revision is restored. The downloaded revision and saved local bytes remain available. This file stays held until you finish the downloaded update." : result.reason === "pinned-original-restoration-held" ? "Original restoration was interrupted. All recorded recovery copies remain held. Retry restoration or finish the downloaded update after verification." : recoveryReason(result.reason))
      await refresh()
    } catch (failure) { setError(cleanError(failure)) } finally { setBusy("") }
  }
  const revealCopies = async (entry: RecoveryEntry) => {
    setBusy(entry.id); setError(""); setMessage("")
    try {
      await window.meetingRecorder.driveRequest("recover", { kind: entry.type, id: entry.id, revealCopies: true })
      setMessage(entry.type === "remote-copy" || entry.type === "remote-remove" ? "File Explorer shows the retained offline copy. Copy it to another location if you want to keep or edit it." : entry.type === "pinned-copy" ? "Saved copies are open in File Explorer. previous contains the original offline file; preserved files contain the local bytes saved before finishing. Copy a file to a new location to inspect it." : "Recovery copies are open in File Explorer. previous contains the original offline file; content contains the downloaded revision. Copy either file to a new location to inspect it.")
    } catch (failure) { setError(cleanError(failure)) } finally { setBusy("") }
  }
  const revealDeletion = async (entry: RecoveryEntry) => {
    setBusy(entry.id); setError(""); setMessage("")
    try { await window.meetingRecorder.driveRequest("recover", { kind: "delete", id: entry.id, revealFile: true }); setMessage("The held file is selected in File Explorer. Retry deleting it when you are ready.") }
    catch (failure) { setError(cleanError(failure)) } finally { setBusy("") }
  }
  const removeSavedEntry = async (entry: RecoveryEntry) => {
    setBusy(entry.id); setError(""); setMessage(""); setConfirmRemoval(null)
    try {
      await window.meetingRecorder.driveRequest("recover", { kind: entry.type, id: entry.id, forget: true })
      setMessage("The recovery entry was removed. The saved files remain in their folder on this PC.")
      await refresh()
    } catch (failure) { setError(cleanError(failure)) } finally { setBusy("") }
  }
  if (!pending.count && !error && !message) return null
  return (
    <div className="mt-10">
      <SubHeader title="Recovery and saved copies" description="Check interrupted transfers or open local copies preserved during recovery. Ember clears a transfer hold only after verifying its result." />
      {!mounted && pending.entries.some(entry => entry.type !== "pinned-copy" && entry.type !== "remote-copy") ? <p className="mb-3 text-[13px] text-muted-foreground">Connect the drive to check interrupted transfers. Saved copies can be opened while disconnected.</p> : null}
      <div className="divide-y divide-border rounded-xl border border-border">
        {pending.entries.map(entry => (
          <div key={`${entry.type}:${entry.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-0 basis-full"><p className="truncate text-[13px]" title={entry.local}>{entry.local}</p><p className="text-[12px] text-faint">{entry.type === "delete" ? entry.directory ? "Held folder deletion" : "Held file deletion" : entry.type === "remote-copy" ? "Offline copy retained after cloud deletion" : entry.type === "remote-remove" ? "Held remote reconciliation" : entry.type === "pinned-copy" ? "Saved local recovery copies" : entry.type === "pinned" ? "Pinned file update" : entry.type === "folder-move" ? "Folder move" : entry.type === "move" ? "File move" : entry.type === "backup" ? "Local backup copy" : entry.type === "folder" ? "Folder upload" : "File upload"}</p></div>
            {entry.type === "delete" ? <Button variant="ghost" size="sm" disabled={!mounted || Boolean(busy)} onClick={() => void revealDeletion(entry)}>Show in File Explorer</Button> : null}
            {(entry.type === "pinned-copy" || entry.type === "remote-copy") ? <Button variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => void revealCopies(entry)}>Reveal saved copies</Button> : null}
            {(entry.type === "pinned-copy" || entry.type === "remote-copy") ? <Button variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => { setConfirmRestore(null); setConfirmFinish(null); setConfirmRemoval(entry) }}>Remove from list</Button> : null}
            {(entry.type === "pinned" || entry.type === "remote-remove" && entry.hasCopies) ? <Button variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => void revealCopies(entry)}>Reveal recovery copies</Button> : null}
            {entry.type === "move" && finishable.includes(entry.id) ? <Button variant="ghost" size="sm" disabled={!mounted || Boolean(busy)} onClick={() => void check(entry, true)}>Finish verified move</Button> : null}
            {entry.type === "folder-move" && finishable.includes(entry.id) ? <Button variant="ghost" size="sm" disabled={!mounted || Boolean(busy)} onClick={() => { setConfirmRestore(null); setConfirmRemoval(null); setConfirmFinish(entry) }}>Finish recorded folder move</Button> : null}
            {entry.type === "pinned" && restoreable.includes(entry.id) ? <Button variant="ghost" size="sm" disabled={!mounted || Boolean(busy)} onClick={() => { setConfirmFinish(null); setConfirmRemoval(null); setConfirmRestore(entry) }}>Restore original offline file</Button> : null}
            {entry.type === "pinned" && finishable.includes(entry.id) ? <Button variant="ghost" size="sm" disabled={!mounted || Boolean(busy)} onClick={() => { setConfirmRestore(null); setConfirmRemoval(null); setConfirmFinish(entry) }}>Finish downloaded update</Button> : null}
            {(entry.type !== "pinned-copy" && entry.type !== "remote-copy") ? <Button variant="ghost" size="sm" disabled={!mounted || Boolean(busy)} onClick={() => void check(entry)}>{busy === entry.id ? <><Spinner /> Checking…</> : entry.type === "delete" ? "Check deletion" : "Check transfer"}</Button> : null}
          </div>
        ))}
      </div>
      {confirmRestore ? <div ref={confirmationRef} tabIndex={-1} className="mt-3 rounded-xl border border-border p-4"><p className="text-[13px] text-muted-foreground">Restore the original offline file for {confirmRestore.local}? Ember saves the current local bytes, then restores the verified original. The downloaded revision and saved copies remain available. The cloud file stays unchanged, and this file stays held until you finish the downloaded update.</p><div className="mt-3 flex gap-2"><Button size="sm" disabled={!mounted || Boolean(busy)} onClick={() => void check(confirmRestore, false, true)}>Save local copy and restore original</Button><Button variant="ghost" size="sm" onClick={() => setConfirmRestore(null)}>Cancel</Button></div></div> : null}
      {confirmFinish ? <div ref={confirmationRef} tabIndex={-1} className="mt-3 rounded-xl border border-border p-4"><p className="text-[13px] text-muted-foreground">{confirmFinish.type === "folder-move" ? `Finish the recorded folder move for ${confirmFinish.local}? Ember completes missing copies at the recorded cloud destination, verifies their bytes and revisions, then removes the original cloud files and confirms the moved local folder.` : `Finish the downloaded update for ${confirmFinish.local}? Ember saves the current local file and retains the original offline revision, then replaces the Drive file with the verified downloaded revision. It leaves the cloud file unchanged.`}</p><div className="mt-3 flex gap-2"><Button size="sm" disabled={!mounted || Boolean(busy)} onClick={() => void check(confirmFinish, true)}>{confirmFinish.type === "folder-move" ? "Verify copies and finish move" : "Save local copy and finish"}</Button><Button variant="ghost" size="sm" onClick={() => setConfirmFinish(null)}>Cancel</Button></div></div> : null}
      {confirmRemoval ? <div ref={confirmationRef} tabIndex={-1} className="mt-3 rounded-xl border border-border p-4"><p className="text-[13px] text-muted-foreground">Remove the saved recovery entry for {confirmRemoval.local}? The files stay in their current folder. Reveal or copy them first if you need to keep track of their location.</p><div className="mt-3 flex gap-2"><Button size="sm" disabled={Boolean(busy)} onClick={() => void removeSavedEntry(confirmRemoval)}>Keep files and remove entry</Button><Button variant="ghost" size="sm" onClick={() => setConfirmRemoval(null)}>Cancel</Button></div></div> : null}
      {pending.count > 50 ? <div className="mt-3 flex items-center gap-3"><Button variant="ghost" size="sm" disabled={!page || Boolean(busy)} onClick={() => setPage(page - 1)}>Previous</Button><span className="text-[12px] text-faint">Page {page + 1} of {Math.ceil(pending.count / 50)}</span><Button variant="ghost" size="sm" disabled={(page + 1) * 50 >= pending.count || Boolean(busy)} onClick={() => setPage(page + 1)}>Next</Button></div> : null}
      {message ? <p role="status" className="mt-3 text-[13px] text-muted-foreground">{message}</p> : null}
      {error ? <p role="alert" className="mt-3 text-[13px] text-destructive">{error}</p> : null}
    </div>
  )
}

/* Connected */


function SavedDriveAccounts({ status }: { status: DriveStatus }) {
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const act = async (_label: string, run: () => Promise<unknown>) => {
    setBusy("account"); setError("")
    try { await run() } catch (failure) { setError(cleanError(failure)) } finally { setBusy("") }
  }
  if ((status.accounts?.length || 0) < 2) return null
  return (
      <>
        <FieldGroup>
          <Field>
            <FieldContent>
              <FieldLabel>Saved storage accounts</FieldLabel>
              <FieldDescription>Each account keeps a separate folder, offline files and recovery copies. Switching disconnects the current folder.</FieldDescription>
            </FieldContent>
            <div className="flex flex-wrap gap-2">
              {status.accounts?.map(account => (
                <Button key={account.id} variant={account.selected ? "pill" : "ghost"} size="sm" className="h-auto max-w-full flex-col items-start gap-0.5 whitespace-normal py-2 text-left" disabled={Boolean(busy) || account.selected} title={account.path} onClick={() => void act("account", () => window.meetingRecorder.driveRequest("recover", { kind: "account", id: account.id, select: true }))}>
                  <span>{account.bucket} · {PROVIDERS.find(provider => provider.id === account.provider)?.title || account.provider}{account.selected ? " · Selected" : ""}</span>
                  {status.accounts?.some(other => other.id !== account.id && other.provider === account.provider && other.bucket === account.bucket) ? <span className="text-[11px] font-normal text-muted-foreground">{account.detail || (account.id === "legacy" ? "Original account" : `Account ${account.id.slice(-8)}`)}</span> : null}
                </Button>
              ))}
            </div>
          </Field>
        </FieldGroup>
      {error ? <p className="text-[12.5px] text-destructive">{error}</p> : null}
      </>
  )
}

function DriveStatusCard({ status, onChange }: { status: DriveStatus; onChange: () => void }) {
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const [confirmForget, setConfirmForget] = useState(false)
  const act = async (label: string, run: () => Promise<unknown>) => {
    setBusy(label)
    setError("")
    try {
      await run()
    } catch (failure) {
      setError(cleanError(failure))
    } finally {
      setBusy("")
    }
  }
  const provider = PROVIDERS.find((entry) => entry.id === status.provider)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 rounded-xl border border-border bg-white/[0.02] px-4 py-3">
        <span className={cn("size-2 shrink-0 rounded-full", status.mounted ? "bg-emerald-400" : "bg-white/30")} />
        <span className="min-w-0 flex-1 text-[13.5px]">
          {status.mounted ? "Connected" : "Not mounted"}
          {status.pendingUploads ? <span className="text-muted-foreground"> · uploading {status.pendingUploads}</span> : null}
          <span className="block truncate text-[12px] text-faint">
            {provider?.title || status.provider} · {status.bucket} · {status.path?.replace(/^\/Users\/[^/]+/, "~")}
          </span>
        </span>
        {status.mounted ? (
          <>
            <Button variant="pill" size="sm" onClick={() => void act("open", () => window.meetingRecorder.driveRequest("open"))}>
              {isWindows() ? "Open in File Explorer" : "Open in Finder"}
            </Button>
            <Button variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => void act("unmount", () => window.meetingRecorder.driveRequest("unmount"))}>
              Unmount
            </Button>
          </>
        ) : (
          <Button variant="pill" size="sm" disabled={Boolean(busy)} onClick={() => void act("mount", () => window.meetingRecorder.driveRequest("mount"))}>
            {busy === "mount" ? <Spinner /> : null} Mount
          </Button>
        )}
      </div>
      {status.needsEnable ? <TurnOn /> : null}
      {status.notice?.message ? (
        <div className="flex items-center gap-2 rounded-lg border border-amber-400/30 bg-amber-400/[0.06] p-2.5 text-[12.5px]">
          <HugeiconsIcon icon={Alert02Icon} strokeWidth={1.8} className="size-4 shrink-0 text-amber-300" />
          <span className="min-w-0 flex-1">{status.notice.message}</span>
          {status.notice.actionTitle && status.notice.actionURL ? (
            <Button size="sm" variant="ghost" onClick={() => void window.meetingRecorder.driveOpenGuide(status.notice!.actionURL!)}>
              {status.notice.actionTitle}
            </Button>
          ) : null}
        </div>
      ) : null}
      {(status.message && !status.needsEnable) || error ? <p className="text-[12.5px] text-rec">{error || status.message}</p> : null}
      <FieldGroup>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel>{isWindows() ? "File Explorer sidebar" : "Finder sidebar"}</FieldLabel>
            <FieldDescription>
              {isWindows()
                ? status.sidebarReady ? "Ember Drive appears in File Explorer’s navigation pane." : "Add the Drive root to File Explorer’s navigation pane."
                : status.sidebarReady
                ? "Ember Drive mounts in /Volumes and sits in Finder's sidebar."
                : "Finder only lists drives in /Volumes in its sidebar. Ember sets that up once, with your Mac's password."}
            </FieldDescription>
          </FieldContent>
          {status.sidebarReady ? (
            <HugeiconsIcon icon={CheckmarkCircle02Icon} strokeWidth={1.8} className="size-5 text-emerald-400" />
          ) : (
            <Button
              variant="pill"
              size="sm"
              disabled={busy === "sidebar"}
              onClick={() =>
                void act("sidebar", async () => {
                  const result = await window.meetingRecorder.driveRequest<{ error: string | null }>("sidebar")
                  if (result?.error && result.error !== "Cancelled") throw new Error(result.error)
                })
              }
            >
              {busy === "sidebar" ? <Spinner /> : null} Add to sidebar
            </Button>
          )}
        </Field>
        <FieldSeparator />
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel>Storage</FieldLabel>
            <FieldDescription>{isWindows() ? "Update storage credentials or connect another account. Each account keeps its own Drive folder." : "Change provider, bucket or keys. The drive remounts on the new settings."}</FieldDescription>
          </FieldContent>
          <div className="flex items-center gap-2">
            <Button variant="pill" size="sm" onClick={onChange}>
              Change…
            </Button>
          </div>
        </Field>
      </FieldGroup>
      {confirmForget ? (
        <div className="flex items-center gap-3 text-[13px] text-muted-foreground">
          {isWindows() ? "Storage credentials are removed from this PC. Cloud files and local recovery records are preserved." : "The drive is unmounted and its settings are removed from this Mac. Your files stay in your storage."}
          <Button variant="destructive" size="sm" className="shrink-0" onClick={() => void act("forget", () => window.meetingRecorder.driveRequest("forget")).then(() => setConfirmForget(false))}>
            Disconnect
          </Button>
        </div>
      ) : (
        <button type="button" className="self-start text-[12.5px] text-faint hover:text-foreground" onClick={() => setConfirmForget(true)}>
          Disconnect Ember Drive
        </button>
      )}
    </div>
  )
}

/** macOS has Ember Drive switched off as a file system: Ember turns it back on, or shows where to. */
function TurnOn() {
  const [busy, setBusy] = useState(false)
  const [manual, setManual] = useState(false)
  const turnOn = async () => {
    setBusy(true)
    const result = await window.meetingRecorder.driveRequest<{ error: string | null }>("enable").catch(() => ({ error: "failed" }))
    setBusy(false)
    if (result?.error) setManual(true)
  }
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-ember/30 bg-ember/[0.06] px-4 py-3 text-[13px]">
      <div className="flex items-center gap-3">
        <HugeiconsIcon icon={Alert02Icon} strokeWidth={1.8} className="size-4 shrink-0 text-ember" />
        <span className="min-w-0 flex-1">
          macOS has Ember Drive turned off
          <span className="block text-[12.5px] text-muted-foreground">
            {manual
              ? "Open System Settings, go to General → Login Items & Extensions → File System Extensions, and switch on Ember Drive. It mounts straight after."
              : "Ember can switch it back on. If macOS asks whether Ember Drive may use data from other apps, choose Allow."}
          </span>
        </span>
      </div>
      <div className="flex gap-2 pl-7">
        <Button size="sm" className="rounded-full" disabled={busy} onClick={() => void turnOn()}>
          {busy ? <Spinner /> : null} {manual ? "Try again" : "Turn on Ember Drive"}
        </Button>
        <Button size="sm" variant="pill" onClick={() => void window.meetingRecorder.driveOpenExtensionSettings()}>
          Open System Settings
        </Button>
      </div>
    </div>
  )
}

function RemoveGhost() {
  const [state, setState] = useState<"idle" | "confirm" | "busy" | "done">("idle")
  if (state === "done") return null
  return (
    <div className="mt-5 flex items-center gap-3 rounded-xl border border-border bg-white/[0.02] px-4 py-3 text-[13px]">
      <span className="min-w-0 flex-1 text-muted-foreground">
        {state === "confirm" ? "Ghost is quit, its drive unmounted, and the app moved to the Trash. Your files stay in your storage." : "Ember Drive replaces Ghost. Ghost is still installed."}
      </span>
      {state === "confirm" ? (
        <Button variant="destructive" size="sm" className="shrink-0" onClick={() => (setState("busy"), void window.meetingRecorder.driveRemoveGhost().then(() => setState("done")))}>
          Remove Ghost
        </Button>
      ) : (
        <Button variant="pill" size="sm" className="shrink-0" disabled={state === "busy"} onClick={() => setState("confirm")}>
          {state === "busy" ? <Spinner /> : null} Remove Ghost…
        </Button>
      )}
    </div>
  )
}

function OfflineFiles({ status }: { status: DriveStatus }) {
  const pins = status.pins || { keys: [], syncing: false, done: 0, total: 0 }
  const [sizes, setSizes] = useState<{ pinnedBytes: number } | null>(null)
  useEffect(() => {
    void window.meetingRecorder.driveRequest<{ pinnedBytes: number }>("cache").then(setSizes, () => {})
  }, [pins.keys.length, pins.syncing])
  return (
    <div className="flex flex-col gap-3">
      {pins.syncing ? (
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Spinner /> Downloading {pins.done} of {pins.total} files…
        </p>
      ) : null}
      {pins.keys.length ? (
        <div className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {pins.keys.map((key) => (
            <div key={key} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
              <span className="min-w-0 flex-1 truncate">{key.replace(/\/$/, "") || "Everything"}</span>
              <span className="text-[12px] text-faint">{key.endsWith("/") ? "Folder" : "File"}</span>
              <Button variant="ghost" size="sm" onClick={() => void window.meetingRecorder.driveRequest("unpin", { keys: [key] })}>
                Remove
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border px-4 py-5 text-[13px] text-muted-foreground">
          {isWindows() ? "Nothing is kept offline yet. Open Drive search, select a file, then choose Keep offline." : "Nothing is kept offline yet. In Finder, right-click a file or folder on Ember Drive and choose Services, then Keep on This Mac (Ember Drive)."}
        </div>
      )}
      {sizes && pins.keys.length ? <p className="text-[12px] text-faint">Offline files use {bytesLabel(sizes.pinnedBytes)} on this {isWindows() ? "PC" : "Mac"}. They're never removed to make room.</p> : null}
    </div>
  )
}

function CacheSettings({ status }: { status: DriveStatus }) {
  const [bytes, setBytes] = useState<number | null>(null)
  const [limit, setLimit] = useState(status.cacheLimitGB || 20)
  const refresh = useCallback(() => void window.meetingRecorder.driveRequest<{ bytes: number }>("cache").then((result) => setBytes(result.bytes), () => {}), [])
  useEffect(refresh, [refresh])
  return (
    <FieldGroup>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="drive-cache">Cache size</FieldLabel>
          <FieldDescription>Offline files are kept separately and don't count. {bytes === null ? "" : `Using ${bytesLabel(bytes)}.`}</FieldDescription>
        </FieldContent>
        <div className="flex items-center gap-2">
          <Select
            value={String(limit)}
            onValueChange={(value) => {
              setLimit(Number(value))
              void window.meetingRecorder.driveRequest("cacheLimit", { gb: Number(value) })
            }}
          >
            <SelectTrigger id="drive-cache" className="w-[110px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CACHE_SIZES.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size} GB
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="pill" size="sm" onClick={() => void window.meetingRecorder.driveRequest("clearCache").then(refresh)}>
            Clear
          </Button>
        </div>
      </Field>
    </FieldGroup>
  )
}

function Backups({ settings, save, mounted, scan }: { settings: SettingsState; save: Save; mounted: boolean; scan?: DriveStatus["backupScan"] }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState("")
  return (
    <FieldGroup>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="drive-recordings">Recordings</FieldLabel>
          <FieldDescription>Each recording as it plays in Ember, its edit if it has one, and its summary and transcript, in Ember/Recordings.</FieldDescription>
        </FieldContent>
        <Switch id="drive-recordings" checked={Boolean(settings.driveBackupRecordings)} onCheckedChange={(checked) => void save({ driveBackupRecordings: checked })} />
      </Field>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="drive-notes">Notes</FieldLabel>
          <FieldDescription>Your meeting notes and digests, in Ember/Notes.</FieldDescription>
        </FieldContent>
        <Switch id="drive-notes" checked={Boolean(settings.driveBackupNotes)} onCheckedChange={(checked) => void save({ driveBackupNotes: checked })} />
      </Field>
      {isWindows() && scan ? <p role="status" className="text-[13px] text-muted-foreground">{scan.running ? "Scanning enabled backups…" : scan.cancelled ? "The backup scan stopped. Interrupted copies remain available for verification." : `Last backup scan queued ${scan.copied} file${scan.copied === 1 ? "" : "s"} for sync.${scan.failed ? ` ${scan.failed} file${scan.failed === 1 ? "" : "s"} could not be copied. Check interrupted transfers or reconnect Drive.` : ""}`}</p> : null}
      {settings.driveBackupRecordings || settings.driveBackupNotes ? (
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel>Back up now</FieldLabel>
            <FieldDescription>{result || "Copies anything that's new or changed. Large recordings upload in the background."}</FieldDescription>
          </FieldContent>
          <Button
            variant="pill"
            size="sm"
            disabled={busy || !mounted}
            onClick={() => {
              setBusy(true)
              void window.meetingRecorder.driveBackupNow().then(
                (count) => (setBusy(false), setResult(count ? `Copied ${count} file${count === 1 ? "" : "s"}. They upload in the background.` : "No new files were copied in this pass.")),
                (error) => (setBusy(false), setResult(cleanError(error))),
              )
            }}
          >
            {busy ? <Spinner /> : null} Back up now
          </Button>
        </Field>
      ) : null}
    </FieldGroup>
  )
}

/* Setting up */

const EMPTY: DriveConfig = { provider: "r2", keyID: "", applicationKey: "", bucketName: "", accountID: "", region: "", endpoint: "" }

export function DriveSetup({ status, onDone, onCancel }: { status: DriveStatus; onDone: () => void; onCancel?: () => void }) {
  const share = useShareState()
  const [mode, setMode] = useState<"quick" | "manual">("quick")
  const [step, setStep] = useState("")
  const [error, setError] = useState("")
  const [working, setWorking] = useState(false)
  const [accounts, setAccounts] = useState<Array<{ id: string; name: string }>>([])
  const [accountID, setAccountID] = useState("")
  const [loadingAccounts, setLoadingAccounts] = useState(false)
  const loadAccounts = useCallback(async () => {
    setLoadingAccounts(true)
    setError("")
    try {
      const available = await window.meetingRecorder.driveCloudflareAccounts()
      setAccounts(available)
      setAccountID((selected) => available.some((account) => account.id === selected) ? selected : available.length === 1 ? available[0].id : "")
      if (!available.length) setError("This Cloudflare login has no accounts.")
    } catch (failure) {
      setError(cleanError(failure))
    } finally {
      setLoadingAccounts(false)
    }
  }, [])
  useEffect(() => {
    if (isWindows() && share.state?.connected && mode === "quick") void loadAccounts()
  }, [share.state?.connected, mode, loadAccounts])
  useEffect(() => window.meetingRecorder.onDriveSetupProgress(setStep), [])

  const quick = async () => {
    setWorking(true)
    setError("")
    try {
      await window.meetingRecorder.driveSetupCloudflare(isWindows() ? { accountID } : undefined)
      onDone()
    } catch (failure) {
      setError(cleanError(failure))
    } finally {
      setWorking(false)
      setStep("")
    }
  }

  const migrate = async () => {
    setWorking(true)
    setError("")
    try {
      if (!(await window.meetingRecorder.driveRequest<boolean>("migrate"))) throw new Error("Ghost's settings weren't found.")
      onDone()
    } catch (failure) {
      setError(cleanError(failure))
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {status.legacyGhost ? (
        <div className="flex items-center gap-3 rounded-xl border border-ember/30 bg-ember/[0.06] px-4 py-3">
          <span className="min-w-0 flex-1 text-[13.5px]">
            Bring your Ghost drive across
            <span className="block text-[12.5px] text-muted-foreground">Same storage, same files and offline list. Ember Drive replaces Ghost.</span>
          </span>
          <Button className="shrink-0 rounded-full" disabled={working} onClick={() => void migrate()}>
            {working ? <Spinner /> : null} Bring it across
          </Button>
        </div>
      ) : null}
      <div className="flex rounded-full border border-border p-0.5 self-start text-[13px]">
        {(
          [
            ["quick", "Use my Cloudflare"],
            ["manual", "Another provider"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" onClick={() => setMode(id)} className={cn("h-7 rounded-full px-3", mode === id ? "bg-white/[0.09] text-foreground" : "text-muted-foreground hover:text-foreground")}>
            {label}
          </button>
        ))}
      </div>
      {mode === "quick" ? (
        <div className="flex flex-col gap-4">
          <p className="max-w-[600px] text-[13.5px] text-muted-foreground">
            Ember makes an <span className="font-mono text-[12.5px]">ember-drive</span> bucket in your Cloudflare account, with a key that can only use that bucket. R2 is free up to 10 GB and
            never charges for downloads.
          </p>
          {share.state === null ? (
            <Spinner />
          ) : !share.state.connected ? (
            <CloudflareSetup state={share.state} onReady={() => void share.refresh()} />
          ) : (
            <>
              {isWindows() ? (
                <Field>
                  <FieldLabel>Cloudflare account</FieldLabel>
                  <Select value={accountID} onValueChange={setAccountID} disabled={working || loadingAccounts}>
                    <SelectTrigger className="max-w-[420px]"><SelectValue placeholder={loadingAccounts ? "Loading accounts…" : "Choose an account"} /></SelectTrigger>
                    <SelectContent>{accounts.map((account) => <SelectItem key={account.id} value={account.id}>{account.name} · {account.id.slice(-6)}</SelectItem>)}</SelectContent>
                  </Select>
                  <button type="button" className="self-start text-[12.5px] text-muted-foreground" disabled={working || loadingAccounts} onClick={() => void loadAccounts()}>Refresh accounts</button>
                </Field>
              ) : null}
              <Button className="h-10 self-start rounded-full px-5" disabled={working || (isWindows() && (loadingAccounts || !accountID))} onClick={() => void quick()}>
                {working ? <Spinner /> : null} {working ? step || "Setting up…" : "Set up Ember Drive"}
              </Button>
            </>
          )}
        </div>
      ) : (
        <ManualSetup onDone={onDone} />
      )}
      {error ? <p className="text-[12.5px] text-rec">{error}</p> : null}
      {onCancel ? (
        <button type="button" className="self-start text-[12.5px] text-faint hover:text-foreground" onClick={onCancel}>
          Keep the current storage
        </button>
      ) : null}
    </div>
  )
}

function ManualSetup({ onDone }: { onDone: () => void }) {
  const [config, setConfig] = useState<DriveConfig>(EMPTY)
  const [saved, setSaved] = useState<DriveConfig | null>(null)
  const [hasSecret, setHasSecret] = useState(false)
  const [checks, setChecks] = useState<DriveCheck[]>([])
  const [testing, setTesting] = useState(false)
  const [passed, setPassed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    void window.meetingRecorder.driveRequest<Partial<DriveConfig> & { hasSecret?: boolean }>("settings").then((current) => {
      if (!current?.provider) return
      const next = { ...EMPTY, ...current, applicationKey: "" } as DriveConfig
      setSaved(next)
      setConfig(next)
      setHasSecret(Boolean(current.hasSecret))
    })
    return window.meetingRecorder.onDriveTest((data) => setChecks(data.checks))
  }, [])

  // Switching providers starts from a clean form, and brings back the saved one when you switch back.
  const pick = (provider: DriveProvider) => {
    if (provider === config.provider) return
    setConfig(saved?.provider === provider ? saved : { ...EMPTY, provider })
    setChecks([])
    setPassed(false)
  }
  const set = (field: SetupField, value: string) => {
    setConfig((current) => ({ ...current, [field]: value }))
    setPassed(false)
  }
  const secretSaved = hasSecret && saved?.provider === config.provider
  const problem = problemWith(config, secretSaved)

  const test = async () => {
    setTesting(true)
    setPassed(false)
    setError("")
    try {
      setPassed(await window.meetingRecorder.driveRequest<boolean>("test", { config }))
    } catch (failure) {
      setError(cleanError(failure))
    } finally {
      setTesting(false)
    }
  }
  const saveAndConnect = async () => {
    setSaving(true)
    try {
      await window.meetingRecorder.driveRequest("save", { config })
      onDone()
    } catch (failure) {
      setError(cleanError(failure))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-2">
        {PROVIDERS.map((provider) => (
          <button
            key={provider.id}
            type="button"
            onClick={() => pick(provider.id)}
            className={cn("flex flex-col items-start gap-0.5 rounded-[12px] border px-3.5 py-2.5 text-left", config.provider === provider.id ? "border-ember bg-ember/[0.07]" : "border-border hover:border-white/25")}
          >
            <span className="flex w-full items-center justify-between text-[13.5px]">
              {provider.title}
              <span className="text-[11.5px] text-faint">{provider.price}</span>
            </span>
            <span className="text-[12px] text-muted-foreground">{provider.blurb}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-3">
        <h4 className="text-[14px] font-semibold">Set up {PROVIDERS.find((entry) => entry.id === config.provider)?.title}</h4>
        <ol className="flex flex-col gap-3">
          {stepsFor(config.provider).map((step, index) => (
            <li key={step.title} className="flex gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border text-[12px] text-muted-foreground">{index + 1}</span>
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className="text-[13.5px]">{step.title}</span>
                <span className="text-[12.5px] text-muted-foreground">{step.detail}</span>
                {step.url ? (
                  <Button variant="pill" size="sm" className="self-start" onClick={() => void window.meetingRecorder.driveOpenGuide(step.url!)}>
                    <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={1.8} /> {step.button}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      </div>

      <div className="flex flex-col gap-3">
        <h4 className="text-[14px] font-semibold">Your details</h4>
        {fieldsFor(config.provider).map((field) => (
          <label key={field} className="flex flex-col gap-1.5">
            <span className="text-[13px]">{labelFor(field, config.provider)}</span>
            {field === "region" && config.provider !== "custom" ? (
              <Select value={config.region} onValueChange={(value) => set("region", value)}>
                <SelectTrigger className="w-full max-w-[420px]">
                  <SelectValue placeholder="Choose a region" />
                </SelectTrigger>
                <SelectContent>
                  {regionsFor(config.provider).map((region) => (
                    <SelectItem key={region} value={region}>
                      {region}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                type={field === "applicationKey" ? "password" : "text"}
                value={config[field]}
                spellCheck={false}
                autoComplete="off"
                placeholder={field === "applicationKey" && secretSaved ? "Saved. Type to replace it" : placeholderFor(field, config.provider)}
                onChange={(event) => set(field, event.target.value)}
                className="max-w-[420px]"
              />
            )}
          </label>
        ))}
        {looksLikeMasterKey(config) ? (
          <p className="text-[12.5px] text-amber-300">That looks like a master key, which can reach every bucket. A key limited to one bucket is safer.</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-3">
        <h4 className="text-[14px] font-semibold">Check the connection</h4>
        <p className="text-[12.5px] text-muted-foreground">Ember writes a tiny test file, reads it back and removes it. Only a setup that works is saved.</p>
        {checks.length ? (
          <ol className="flex flex-col gap-2">
            {checks.map((check) => (
              <li key={check.id} className="flex gap-2.5 text-[13px]">
                <CheckIcon state={check.state} />
                <span className="flex min-w-0 flex-col">
                  {check.title}
                  {check.detail ? <span className={cn("text-[12px]", check.state === "failed" ? "text-rec" : "text-muted-foreground")}>{check.detail}</span> : null}
                </span>
              </li>
            ))}
          </ol>
        ) : null}
        <div className="flex items-center gap-2">
          <Button variant="pill" disabled={Boolean(problem) || testing} onClick={() => void test()}>
            {testing ? <Spinner /> : null} Test connection
          </Button>
          <Button className="rounded-full" disabled={!passed || saving} onClick={() => void saveAndConnect()}>
            {saving ? <Spinner /> : null} Save and mount
          </Button>
          {problem ? <span className="text-[12px] text-faint">{problem}</span> : null}
        </div>
        {error ? <p className="text-[12.5px] text-rec">{error}</p> : null}
      </div>
    </div>
  )
}

function CheckIcon({ state }: { state: DriveCheck["state"] }) {
  if (state === "running") return <Spinner className="mt-0.5 size-4 shrink-0" />
  if (state === "passed") return <HugeiconsIcon icon={CheckmarkCircle02Icon} strokeWidth={1.8} className="mt-0.5 size-4 shrink-0 text-emerald-400" />
  if (state === "warning") return <HugeiconsIcon icon={Alert02Icon} strokeWidth={1.8} className="mt-0.5 size-4 shrink-0 text-amber-300" />
  if (state === "failed") return <HugeiconsIcon icon={Cancel01Icon} strokeWidth={1.8} className="mt-0.5 size-4 shrink-0 text-rec" />
  return <span className="mt-0.5 size-4 shrink-0 rounded-full border border-border" />
}
