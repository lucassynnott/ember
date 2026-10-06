import { useCallback, useEffect, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  AppWindowIcon,
  ArrowReloadHorizontalIcon,
  Camera01Icon,
  CameraOff01Icon,
  Cancel01Icon,
  ComputerIcon,
  CropIcon,
  Delete02Icon,
  Mic01Icon,
  PauseIcon,
  PlayIcon,
  ViewOffSlashIcon,
  VolumeHighIcon,
} from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { EmberMark } from "@/main-window/page"

import type { CameraSize, RecordMode, RecordSources, RecordStatus } from "./bridge"
import { Guide } from "./Guide"
import { DriveSearch } from "@/drive/DriveSearch"

export function App({ role }: { role: string }) {
  switch (role) {
    case "setup":
      return <Setup />
    case "camera":
      return <CameraBubble />
    case "controls":
      return <Controls />
    case "count":
      return <Countdown />
    case "area":
      return <AreaPicker />
    case "guide":
      return <Guide />
    case "drive-search":
      return <DriveSearch />
    case "flash":
      return <div className="m-[2px] h-[calc(100vh-4px)] rounded-[10px] border-4 border-ember shadow-[0_0_40px_rgb(255_122_47/0.6)]" />
    case "frame":
      return <div className="m-[3px] h-[calc(100vh-6px)] rounded-[6px] border-2 border-dashed border-ember/90" />
    default:
      return null
  }
}

function clock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, "0")
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`
}

/* Setup */

const MODES: { id: RecordMode; label: string; icon: typeof ComputerIcon }[] = [
  { id: "screen", label: "Full screen", icon: ComputerIcon },
  { id: "window", label: "Window", icon: AppWindowIcon },
  { id: "area", label: "Area", icon: CropIcon },
  { id: "camera", label: "Camera", icon: Camera01Icon },
]

function useDevices(withCamera: boolean) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      let list = await navigator.mediaDevices.enumerateDevices()
      // Names only show once a device has been allowed; asking briefly unlocks them.
      const unnamed = list.some((device) => (device.kind === "audioinput" || (withCamera && device.kind === "videoinput")) && !device.label)
      if (unnamed) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: withCamera })
          stream.getTracks().forEach((track) => track.stop())
          list = await navigator.mediaDevices.enumerateDevices()
        } catch {}
      }
      if (!cancelled) setDevices(list)
    }
    void load()
    navigator.mediaDevices.addEventListener("devicechange", load)
    return () => {
      cancelled = true
      navigator.mediaDevices.removeEventListener("devicechange", load)
    }
  }, [withCamera])
  return devices
}

const plainLabel = (label: string) => label.replace(/\s+\([^)]*\)\s*$/, "").trim()

function Setup() {
  const [sources, setSources] = useState<RecordSources | null>(null)
  const [mode, setMode] = useState<RecordMode>("screen")
  const [displayId, setDisplayId] = useState<number | null>(null)
  const [windowId, setWindowId] = useState<number | null>(null)
  const [camera, setCamera] = useState(false)
  const [cameraId, setCameraId] = useState("")
  const [microphone, setMicrophone] = useState("default")
  const [systemAudio, setSystemAudio] = useState(false)
  const [countdown, setCountdown] = useState(3)
  const [error, setError] = useState("")
  const [starting, setStarting] = useState(false)
  const devices = useDevices(camera || mode === "camera")
  const cameras = devices.filter((device) => device.kind === "videoinput" && device.deviceId)
  const microphones = devices.filter((device) => device.kind === "audioinput" && device.deviceId && device.deviceId !== "default" && device.label)

  useEffect(() => {
    void window.record.sources().then((result) => {
      if (!result) return
      setSources(result)
      setMode(result.prefs.mode)
      setCamera(result.prefs.camera)
      setCameraId(result.prefs.cameraId)
      setMicrophone(result.prefs.microphone || "default")
      setSystemAudio(Boolean(result.prefs.systemAudio))
      setCountdown(typeof result.prefs.countdown === "number" ? result.prefs.countdown : 3)
      setDisplayId((result.displays.find((display) => display.current) || result.displays[0])?.id ?? null)
    })
    return window.record.onError(setError)
  }, [])

  const start = useCallback(async () => {
    if (starting) return
    if (mode === "window" && !windowId) {
      setError("Pick a window to record.")
      return
    }
    const chosenCamera = cameras.find((device) => device.deviceId === cameraId) || cameras[0]
    if (mode === "camera" && !chosenCamera) {
      setError("No camera is connected.")
      return
    }
    setStarting(true)
    setError("")
    await window.record.start({
      mode,
      displayId: displayId ?? undefined,
      windowId: windowId ?? undefined,
      microphone,
      cameraName: chosenCamera ? plainLabel(chosenCamera.label) : undefined,
      systemAudio: mode !== "camera" && systemAudio,
      countdown,
    })
    setStarting(false)
  }, [mode, displayId, windowId, microphone, starting, cameras, cameraId, systemAudio, countdown])

  useEffect(() => window.record.onStartNow(() => void start()), [start])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") window.record.close()
      if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) void start()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [start])

  const toggleCamera = (on: boolean) => {
    setCamera(on)
    void window.record.camera({ on, deviceId: cameraId })
  }
  const chooseCamera = (id: string) => {
    setCameraId(id)
    void window.record.camera({ on: true, deviceId: id })
  }

  const displays = sources?.displays || []
  const windows = sources?.windows || []

  return (
    <div className="h-screen p-2">
      <div className="flex h-full flex-col overflow-hidden rounded-[22px] border border-white/10 bg-[#191919] shadow-[0_24px_80px_rgb(0_0_0/0.55)]">
        <header className="drag flex items-center gap-2.5 px-5 pt-4 pb-3">
          <EmberMark className="size-[22px]" />
          <h1 className="text-[17px] font-semibold tracking-[-0.02em]">Record</h1>
          <button
            type="button"
            aria-label="Close"
            onClick={() => window.record.close()}
            className="no-drag ml-auto flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-white/[0.07] hover:text-foreground"
          >
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={1.8} className="size-4" />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-4 px-5 pb-5">
          <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="What to record">
            {MODES.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={mode === option.id}
                onClick={() => {
                  setMode(option.id)
                  setError("")
                  // Camera only needs the camera on, as your preview.
                  if (option.id === "camera" && !camera) toggleCamera(true)
                }}
                className={cn(
                  "flex h-[74px] flex-col items-center justify-center gap-1.5 rounded-[14px] border text-[12.5px] transition-colors",
                  mode === option.id ? "border-ember/70 bg-ember/[0.09] text-foreground" : "border-white/[0.08] bg-white/[0.03] text-muted-foreground hover:text-foreground",
                )}
              >
                <HugeiconsIcon icon={option.icon} strokeWidth={1.6} className={cn("size-[22px]", mode === option.id && "text-ember")} />
                {option.label}
              </button>
            ))}
          </div>

          {mode === "window" ? (
            <div className="flex min-h-0 flex-1 flex-col gap-1.5">
              <span className="text-[12px] font-medium tracking-wide text-faint uppercase">Window</span>
              <div className="min-h-0 flex-1 overflow-y-auto rounded-[12px] border border-white/[0.08] bg-black/20 p-1">
                {windows.length ? (
                  windows.map((window) => (
                    <button
                      key={window.id}
                      type="button"
                      onClick={() => {
                        setWindowId(window.id)
                        setError("")
                        window.id && globalThis.window.record.highlight(window.id)
                      }}
                      className={cn(
                        "flex w-full flex-col items-start rounded-[9px] px-3 py-2 text-left",
                        windowId === window.id ? "bg-ember/[0.12]" : "hover:bg-white/[0.05]",
                      )}
                    >
                      <span className="text-[13.5px] font-medium">{window.app}</span>
                      {window.title ? <span className="w-full truncate text-[12px] text-muted-foreground">{window.title}</span> : null}
                    </button>
                  ))
                ) : (
                  <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">{sources ? "No windows to record." : "Finding windows…"}</p>
                )}
              </div>
            </div>
          ) : mode === "camera" ? (
            <p className="rounded-[12px] border border-white/[0.06] bg-white/[0.02] px-3.5 py-3 text-[13px] text-muted-foreground">
              Records just your camera and microphone, without your screen. The bubble is your preview.
            </p>
          ) : displays.length > 1 ? (
            <Row label="Display">
              <Select value={String(displayId ?? "")} onValueChange={(value) => setDisplayId(Number(value))}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {displays.map((display) => (
                    <SelectItem key={display.id} value={String(display.id)}>
                      {display.label} · {display.width}×{display.height}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
          ) : null}

          <div className="flex flex-col gap-3 rounded-[14px] border border-white/[0.08] bg-white/[0.02] p-3">
            <div className="flex items-center gap-2.5">
              <HugeiconsIcon icon={camera ? Camera01Icon : CameraOff01Icon} strokeWidth={1.6} className="size-[18px] text-muted-foreground" />
              <label htmlFor="record-camera" className="text-[14px]">
                Camera
              </label>
              {mode === "camera" ? null : <Switch id="record-camera" className="ml-auto" checked={camera} onCheckedChange={toggleCamera} />}
            </div>
            {(camera || mode === "camera") && cameras.length > 1 ? (
              <Select value={cameraId || cameras[0]?.deviceId} onValueChange={chooseCamera}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {cameras.map((device) => (
                    <SelectItem key={device.deviceId} value={device.deviceId}>
                      {plainLabel(device.label) || "Camera"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <div className="h-px bg-white/[0.06]" />
            <div className="flex items-center gap-2.5">
              <HugeiconsIcon icon={Mic01Icon} strokeWidth={1.6} className="size-[18px] text-muted-foreground" />
              <MicMeter microphone={microphone} devices={microphones} />
              <Select value={microphone} onValueChange={setMicrophone}>
                <SelectTrigger className="h-8 flex-1 border-0 bg-transparent px-1.5 text-[14px] shadow-none">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Default microphone</SelectItem>
                  {microphones.map((device) => (
                    <SelectItem key={device.deviceId} value={plainLabel(device.label)}>
                      {plainLabel(device.label)}
                    </SelectItem>
                  ))}
                  {microphone !== "default" && microphone !== "none" && !microphones.some((device) => plainLabel(device.label) === microphone) ? (
                    <SelectItem value={microphone}>{microphone}</SelectItem>
                  ) : null}
                  <SelectItem value="none">No microphone</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {mode !== "camera" ? (
              <>
                <div className="h-px bg-white/[0.06]" />
                <div className="flex items-center gap-2.5">
                  <HugeiconsIcon icon={VolumeHighIcon} strokeWidth={1.6} className="size-[18px] text-muted-foreground" />
                  <label htmlFor="record-system" className="text-[14px]">
                    System audio
                  </label>
                  <Switch id="record-system" className="ml-auto" checked={systemAudio} onCheckedChange={setSystemAudio} />
                </div>
              </>
            ) : null}
          </div>

          {mode !== "window" ? <div className="flex-1" /> : null}
          {error ? <p className="text-[13px] text-rec">{error}</p> : null}
          <Button className="h-11 rounded-full text-[15px] font-medium" disabled={starting || !sources} onClick={() => void start()}>
            {starting ? <Spinner /> : <span className="size-2.5 rounded-full bg-[#1c0a03]" />}
            {mode === "area" ? "Choose area and record" : "Start recording"}
          </Button>
          <p className="-mt-1 text-center text-[12px] text-faint">
            {sources?.prefs.shortcut ? (
              <>
                <Kbd>{sources.prefs.shortcut}</Kbd> starts and stops
              </>
            ) : null}
            {sources?.prefs.shortcut ? " · " : null}
            <span className="inline-flex items-center gap-1">
              Countdown
              {[0, 3, 5, 10].map((seconds) => (
                <button
                  key={seconds}
                  type="button"
                  onClick={() => setCountdown(seconds)}
                  className={cn("rounded px-1 tabular", countdown === seconds ? "bg-white/10 text-foreground" : "hover:text-foreground")}
                >
                  {seconds ? `${seconds}s` : "off"}
                </button>
              ))}
            </span>
          </p>
        </div>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium tracking-wide text-faint uppercase">{label}</span>
      {children}
    </div>
  )
}

/** A small live level meter for the chosen microphone. */
function MicMeter({ microphone, devices }: { microphone: string; devices: MediaDeviceInfo[] }) {
  const [level, setLevel] = useState(0)
  useEffect(() => {
    if (microphone === "none") {
      setLevel(0)
      return
    }
    let stream: MediaStream | null = null
    let context: AudioContext | null = null
    let frame = 0
    let cancelled = false
    const device = devices.find((item) => plainLabel(item.label) === microphone)
    navigator.mediaDevices
      .getUserMedia({ audio: device ? { deviceId: { exact: device.deviceId } } : true })
      .then((opened) => {
        if (cancelled) return opened.getTracks().forEach((track) => track.stop())
        stream = opened
        context = new AudioContext()
        const analyser = context.createAnalyser()
        analyser.fftSize = 512
        context.createMediaStreamSource(opened).connect(analyser)
        const data = new Float32Array(analyser.fftSize)
        const tick = () => {
          analyser.getFloatTimeDomainData(data)
          let sum = 0
          for (const sample of data) sum += sample * sample
          setLevel((current) => Math.max(Math.min(1, Math.sqrt(sum / data.length) * 5), current * 0.85))
          frame = requestAnimationFrame(tick)
        }
        tick()
      })
      .catch(() => setLevel(0))
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      stream?.getTracks().forEach((track) => track.stop())
      void context?.close()
    }
  }, [microphone, devices])
  return (
    <div className="order-last ml-1 h-1.5 w-12 overflow-hidden rounded-full bg-white/10" aria-hidden>
      <div className="h-full rounded-full bg-ember transition-[width] duration-75" style={{ width: `${Math.round(level * 100)}%` }} />
    </div>
  )
}

/* Camera bubble */

const SIZES: { id: CameraSize; label: string }[] = [
  { id: "small", label: "S" },
  { id: "medium", label: "M" },
  { id: "large", label: "L" },
]

function CameraBubble() {
  const video = useRef<HTMLVideoElement>(null)
  const [camera, setCamera] = useState<{ deviceId: string; size: CameraSize } | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    void window.record.status().then((status) => status && setCamera((current) => current || { deviceId: status.cameraId || "", size: status.cameraSize || "medium" }))
    return window.record.onCamera(setCamera)
  }, [])

  const deviceId = camera?.deviceId
  useEffect(() => {
    if (camera === null) return
    let stream: MediaStream | null = null
    let cancelled = false
    const constraints: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
    navigator.mediaDevices
      .getUserMedia({ video: deviceId ? { ...constraints, deviceId: { exact: deviceId } } : constraints })
      .catch(() => navigator.mediaDevices.getUserMedia({ video: constraints }))
      .then((opened) => {
        if (cancelled) return opened.getTracks().forEach((track) => track.stop())
        stream = opened
        setFailed(false)
        if (video.current) video.current.srcObject = opened
      })
      .catch(() => setFailed(true))
    return () => {
      cancelled = true
      stream?.getTracks().forEach((track) => track.stop())
    }
    // Only a new device reopens the camera; a new size doesn't.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, camera === null])

  return (
    <div className="drag group relative size-full overflow-hidden rounded-full bg-[#111] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)]">
      <video ref={video} autoPlay muted playsInline className="size-full -scale-x-100 object-cover" />
      {failed ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center text-[12px] text-muted-foreground">
          <HugeiconsIcon icon={CameraOff01Icon} strokeWidth={1.6} className="size-6" />
          No camera
        </div>
      ) : null}
      <div className="no-drag absolute inset-x-0 bottom-[12%] flex justify-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        {SIZES.map((size) => (
          <button
            key={size.id}
            type="button"
            aria-label={`${size.id} camera`}
            onClick={() => window.record.cameraSize(size.id)}
            className={cn(
              "flex size-6 items-center justify-center rounded-full text-[11px] font-semibold backdrop-blur",
              camera?.size === size.id ? "bg-white text-black" : "bg-black/60 text-white hover:bg-black/80",
            )}
          >
            {size.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/* Controls */

function Controls() {
  const [status, setStatus] = useState<RecordStatus>({ state: "starting", paused: false, elapsed: 0, running: false })
  const [received, setReceived] = useState(() => Date.now())
  const [, setTick] = useState(0)
  const [level, setLevel] = useState(0)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    const apply = (next: RecordStatus) => {
      setStatus(next)
      setReceived(Date.now())
    }
    void window.record.status().then((next) => next && apply(next))
    const offState = window.record.onState(apply)
    const offLevel = window.record.onLevel((value) => setLevel((current) => Math.max(value, current * 0.6)))
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 250)
    return () => {
      offState()
      offLevel()
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (!confirmDelete) return
    const timer = window.setTimeout(() => setConfirmDelete(false), 3000)
    return () => window.clearTimeout(timer)
  }, [confirmDelete])

  const elapsed = status.elapsed + (status.running ? Date.now() - received : 0)
  const live = status.state === "recording"
  const saving = status.state === "saving"

  return (
    <div className="flex h-screen items-center justify-center">
      <div className="drag flex w-[52px] flex-col items-center gap-1.5 rounded-full border border-white/[0.12] bg-[#141414]/95 py-2.5 shadow-[0_12px_40px_rgb(0_0_0/0.5)]">
        <button
          type="button"
          title="Stop and save"
          aria-label="Stop and save"
          disabled={!live}
          onClick={() => window.record.control("stop")}
          className="no-drag flex size-10 items-center justify-center rounded-full bg-rec transition hover:brightness-110 disabled:opacity-60"
        >
          {saving || status.state === "starting" ? <Spinner className="size-4 text-white" /> : <span className="size-3.5 rounded-[3px] bg-white" />}
        </button>
        <span className={cn("tabular py-0.5 text-[12px] font-medium", status.paused ? "text-ember" : "text-foreground/90")}>{saving ? "Saving" : clock(elapsed)}</span>
        <div className="h-1 w-7 overflow-hidden rounded-full bg-white/10" aria-hidden>
          <div className="h-full rounded-full bg-ember transition-[width] duration-100" style={{ width: `${status.paused ? 0 : Math.round(level * 100)}%` }} />
        </div>
        <div className="my-1 h-px w-6 bg-white/10" />
        <ControlButton
          label={status.paused ? "Resume" : "Pause"}
          icon={status.paused ? PlayIcon : PauseIcon}
          disabled={!live}
          active={status.paused}
          onClick={() => window.record.control(status.paused ? "resume" : "pause")}
        />
        <ControlButton label="Start over" icon={ArrowReloadHorizontalIcon} disabled={!live} onClick={() => window.record.control("restart")} />
        {status.camera !== null && status.camera !== undefined ? (
          <ControlButton label={status.camera ? "Hide camera preview" : "Show camera preview"} icon={status.camera ? Camera01Icon : CameraOff01Icon} onClick={() => window.record.control("toggle-camera")} />
        ) : null}
        <ControlButton
          label={confirmDelete ? "Click again to delete" : "Delete recording"}
          icon={Delete02Icon}
          disabled={saving}
          danger={confirmDelete}
          onClick={() => (confirmDelete ? window.record.control("cancel") : setConfirmDelete(true))}
        />
        <ControlButton label="Hide controls (bring them back from the menu bar)" icon={ViewOffSlashIcon} onClick={() => window.record.control("hide-controls")} />
      </div>
    </div>
  )
}

function ControlButton({
  label,
  icon,
  onClick,
  disabled,
  active,
  danger,
}: {
  label: string
  icon: typeof PlayIcon
  onClick: () => void
  disabled?: boolean
  active?: boolean
  danger?: boolean
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "no-drag flex size-9 items-center justify-center rounded-full transition-colors disabled:opacity-40",
        danger ? "bg-rec text-white" : active ? "bg-ember/20 text-ember" : "text-foreground/80 hover:bg-white/[0.08] hover:text-foreground",
      )}
    >
      <HugeiconsIcon icon={icon} strokeWidth={1.8} className="size-[18px]" />
    </button>
  )
}

/* Countdown */

function Countdown() {
  const [count, setCount] = useState(3)
  useEffect(() => window.record.onCount(setCount), [])
  return (
    <button
      type="button"
      onClick={() => window.record.skipCount()}
      className="flex size-full items-center justify-center"
      aria-label="Start now"
    >
      <span className="flex size-[200px] flex-col items-center justify-center rounded-full border-2 border-ember/80 bg-[#0d0d0d]/90 shadow-[0_0_48px_rgb(255_110_40/0.35)]">
        <span key={count} className="animate-in zoom-in-75 fade-in text-[96px] leading-none font-semibold tracking-[-0.04em] text-white duration-300">
          {count}
        </span>
        <span className="mt-2 text-[12px] text-white/60">Click to start now</span>
      </span>
    </button>
  )
}

/* Area */

type Rect = { x: number; y: number; width: number; height: number }

function AreaPicker() {
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null)
  const [rect, setRect] = useState<Rect | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") window.record.area(null)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const toRect = (from: { x: number; y: number }, to: { x: number; y: number }): Rect => ({
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  })

  return (
    <div
      className="relative h-screen w-screen cursor-crosshair select-none"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId)
        setOrigin({ x: event.clientX, y: event.clientY })
        setRect(null)
      }}
      onPointerMove={(event) => origin && setRect(toRect(origin, { x: event.clientX, y: event.clientY }))}
      onPointerUp={(event) => {
        if (!origin) return
        const chosen = toRect(origin, { x: event.clientX, y: event.clientY })
        setOrigin(null)
        if (chosen.width >= 40 && chosen.height >= 40) window.record.area(chosen)
        else setRect(null)
      }}
    >
      {rect ? (
        <div
          className="pointer-events-none absolute rounded-[3px] border-2 border-ember shadow-[0_0_0_9999px_rgb(0_0_0/0.45)]"
          style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
        >
          <span className="tabular absolute -top-8 left-0 rounded-md bg-black/80 px-2 py-1 text-[12px] whitespace-nowrap text-white">
            {Math.round(rect.width)} × {Math.round(rect.height)}
          </span>
        </div>
      ) : (
        <div className="pointer-events-none absolute inset-0 bg-black/45">
          <div className="absolute top-[18%] left-1/2 -translate-x-1/2 rounded-full border border-white/15 bg-black/80 px-5 py-2.5 text-[14px] text-white shadow-xl">
            Drag to choose the area to record · <span className="text-white/60">Esc to cancel</span>
          </div>
        </div>
      )}
    </div>
  )
}
