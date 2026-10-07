import { useEffect, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  AlignLeftIcon,
  AlignRightIcon,
  ArrowDown01Icon,
  ArrowDownLeft01Icon,
  ArrowDownRight01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  ArrowUpLeft01Icon,
  ArrowUpRight01Icon,
  Delete02Icon,
  TextAlignCenterIcon,
  TextBoldIcon,
  TextItalicIcon,
  TextUnderlineIcon,
} from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

import { mergeCaptions, retextCaption, retimeCaption, splitCaption } from "./captions"
import { CURSOR_STYLES, cursorSprite } from "./cursors"
import {
  DEFAULT_LAYOUT,
  type LayoutPreset,
  DEFAULT_CAPTION_STYLE,
  DEFAULT_CURSOR,
  DEFAULT_SCENE,
  DEFAULT_WEBCAM,
  SPEED_MAX,
  SPEED_MIN,
  ZOOM_DEPTHS,
  deleteClip,
  updateClip,
  type Annotation,
  type ArrowDirection,
  type Caption,
  type EditProject,
  type WebcamPosition,
} from "./model"
import { ASPECTS, COLORS, GRADIENTS, gradientCss } from "./scene"
import { FONTS } from "./render"

type Change = (next: EditProject | ((current: EditProject) => EditProject), options?: { live?: boolean }) => void

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/* Building blocks */

export function Section({ title, children, onReset, advanced, onAdvanced }: { title: string; children: React.ReactNode; onReset?: () => void; advanced?: boolean; onAdvanced?: (on: boolean) => void }) {
  return (
    <section className="flex flex-col gap-4 border-b border-border px-5 py-4 last:border-b-0">
      <div className="flex items-center gap-3">
        <h2 className="text-[12px] font-medium tracking-wide text-faint uppercase">{title}</h2>
        <div className="ml-auto flex items-center gap-3">
          {onAdvanced ? (
            <label className="flex items-center gap-1.5 text-[11.5px] text-faint">
              Advanced
              <Switch size="sm" checked={Boolean(advanced)} onCheckedChange={onAdvanced} />
            </label>
          ) : null}
          {onReset ? (
            <button type="button" className="text-[11.5px] text-faint hover:text-foreground" onClick={onReset}>
              Reset
            </button>
          ) : null}
        </div>
      </div>
      {children}
    </section>
  )
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
  onCommit,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (value: number) => string
  onChange: (value: number) => void
  onCommit?: () => void
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex justify-between text-[13px]">
        {label}
        <span className="tabular text-muted-foreground">{format(value)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
        className="w-full accent-[var(--ember)]"
      />
    </label>
  )
}

export function Chips<T extends string | number>({ options, value, onChange, format }: { options: readonly T[]; value: T; onChange: (value: T) => void; format?: (value: T) => string }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => (
        <button
          key={String(option)}
          type="button"
          onClick={() => onChange(option)}
          className={cn(
            "h-8 rounded-full border px-3 text-[12.5px] transition-colors",
            option === value ? "border-ember/70 bg-ember/[0.12] text-foreground" : "border-white/[0.09] text-muted-foreground hover:text-foreground",
          )}
        >
          {format ? format(option) : String(option)}
        </button>
      ))}
    </div>
  )
}

function Toggle({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return (
    <label className={cn("flex items-center justify-between gap-3 text-[13px]", disabled && "opacity-50")}>
      <span>
        {label}
        {hint ? <span className="block text-[11.5px] text-faint">{hint}</span> : null}
      </span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </label>
  )
}

function ColorField({ label, value, onChange, options = COLORS, allowNone }: { label: string; value: string | null; onChange: (value: string | null) => void; options?: string[]; allowNone?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px]">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {allowNone ? (
          <button
            type="button"
            title="None"
            onClick={() => onChange(null)}
            className={cn("size-6 rounded-full border-2 bg-[repeating-conic-gradient(#2a2a2a_0%_25%,#1c1c1c_0%_50%)] bg-[length:8px_8px]", value === null ? "border-ember" : "border-white/15")}
          />
        ) : null}
        {options.map((color) => (
          <button
            key={color}
            type="button"
            title={color}
            onClick={() => onChange(color)}
            className={cn("size-6 rounded-full border-2", value?.toLowerCase() === color.toLowerCase() ? "border-ember" : "border-white/15")}
            style={{ background: color }}
          />
        ))}
        <label title="Custom colour" className="relative size-6 cursor-pointer overflow-hidden rounded-full border-2 border-white/15 bg-[conic-gradient(red,yellow,lime,cyan,blue,magenta,red)]">
          <input type="color" value={value || "#ffffff"} onChange={(event) => onChange(event.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
        </label>
      </div>
    </div>
  )
}

/** Live while dragging a slider, one undo step when let go. */
function useLive(change: Change) {
  return {
    live: (update: (current: EditProject) => EditProject) => change(update, { live: true }),
    commit: () => change((current) => ({ ...current })),
  }
}

/* Scene */

export function ScenePanel({ project, change, wallpapers, hasCamera }: { project: EditProject; change: Change; wallpapers: { id: string; label: string; url: string; thumb: string }[]; hasCamera: boolean }) {
  const [advanced, setAdvanced] = useState(false)
  const [tab, setTab] = useState<"image" | "video" | "color" | "gradient">(() =>
    project.scene.background.kind === "video" ? "video" : project.scene.background.kind === "color" ? "color" : project.scene.background.kind === "gradient" ? "gradient" : "image",
  )
  const { live, commit } = useLive(change)
  const scene = project.scene
  const setScene = (changes: Partial<typeof scene>) => change((current) => ({ ...current, scene: { ...current.scene, ...changes } }))
  const liveScene = (changes: Partial<typeof scene>) => live((current) => ({ ...current, scene: { ...current.scene, ...changes } }))
  const setBackground = (kind: typeof scene.background.kind, value: string) =>
    change((current) => ({
      ...current,
      // Picking a background frames the video, so it gets padding if it had none.
      scene: { ...current.scene, background: { kind, value }, ...(current.scene.background.kind === "none" ? { padding: DEFAULT_SCENE.padding, radius: DEFAULT_SCENE.radius } : {}) },
    }))
  const [uploads, setUploads] = useState<{ name: string; url: string; kind: string }[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("ember.editor.uploads") || "[]")
    } catch {
      return []
    }
  })
  const pick = async (kind: "image" | "video") => {
    const asset = await window.meetingRecorder.editorPick(kind)
    if (!asset) return
    const next = [asset, ...uploads.filter((item) => item.url !== asset.url)].slice(0, 24)
    setUploads(next)
    localStorage.setItem("ember.editor.uploads", JSON.stringify(next))
    setBackground(kind, asset.url)
  }
  const removeUpload = (url: string) => {
    const next = uploads.filter((item) => item.url !== url)
    setUploads(next)
    localStorage.setItem("ember.editor.uploads", JSON.stringify(next))
  }
  const framed = scene.background.kind !== "none"
  const padding = scene.padding
  const Tile = ({ selected, onClick, style, title, children }: { selected: boolean; onClick: () => void; style?: React.CSSProperties; title: string; children?: React.ReactNode }) => (
    <button type="button" title={title} onClick={onClick} className={cn("relative aspect-video overflow-hidden rounded-[8px] border-2 bg-cover bg-center transition", selected ? "border-ember" : "border-transparent hover:border-white/25")} style={style}>
      {children}
    </button>
  )
  return (
    <>
      <Section title="Background" advanced={advanced} onAdvanced={setAdvanced} onReset={() => setScene({ background: { kind: "none", value: "" }, blur: 0 })}>
        <Toggle
          label="Remove background"
          hint="The video on its own, at its own shape"
          checked={!framed}
          onChange={(on) => (on ? setScene({ background: { kind: "none", value: "" }, aspect: "native" }) : setBackground("gradient", "ember"))}
        />
        <div className="flex rounded-full border border-border p-0.5 text-[12.5px]">
          {(["image", "video", "color", "gradient"] as const).map((id) => (
            <button key={id} type="button" onClick={() => setTab(id)} className={cn("h-7 flex-1 rounded-full capitalize", tab === id ? "bg-white/[0.09] text-foreground" : "text-muted-foreground")}>
              {id === "color" ? "Colour" : id}
            </button>
          ))}
        </div>
        {tab === "image" ? (
          <div className="grid grid-cols-3 gap-1.5">
            <button type="button" onClick={() => void pick("image")} className="flex aspect-video items-center justify-center rounded-[8px] border border-dashed border-white/20 text-[11.5px] text-muted-foreground hover:text-foreground">
              Add picture
            </button>
            {uploads
              .filter((item) => item.kind === "image")
              .map((item) => (
                <Tile key={item.url} title={item.name} selected={scene.background.value === item.url} onClick={() => setBackground("image", item.url)} style={{ backgroundImage: `url("${item.url}")` }}>
                  <span
                    role="button"
                    title="Remove"
                    onClick={(event) => {
                      event.stopPropagation()
                      removeUpload(item.url)
                    }}
                    className="absolute top-1 right-1 rounded bg-black/70 px-1 text-[10px] text-white"
                  >
                    ✕
                  </span>
                </Tile>
              ))}
            {wallpapers.map((wallpaper) => (
              <Tile key={wallpaper.id} title={wallpaper.label} selected={scene.background.value === wallpaper.url} onClick={() => setBackground("wallpaper", wallpaper.url)} style={{ backgroundImage: `url("${wallpaper.thumb}")` }} />
            ))}
          </div>
        ) : tab === "video" ? (
          <div className="grid grid-cols-3 gap-1.5">
            <button type="button" onClick={() => void pick("video")} className="flex aspect-video items-center justify-center rounded-[8px] border border-dashed border-white/20 text-[11.5px] text-muted-foreground hover:text-foreground">
              Add video
            </button>
            {uploads
              .filter((item) => item.kind === "video")
              .map((item) => (
                <Tile key={item.url} title={item.name} selected={scene.background.value === item.url} onClick={() => setBackground("video", item.url)}>
                  <video src={item.url} muted className="absolute inset-0 size-full object-cover" />
                </Tile>
              ))}
          </div>
        ) : tab === "color" ? (
          <ColorField label="Colour" value={scene.background.kind === "color" ? scene.background.value : null} onChange={(color) => color && setBackground("color", color)} />
        ) : (
          <div className="grid grid-cols-6 gap-1.5">
            {GRADIENTS.map((gradient) => (
              <button
                key={gradient.id}
                type="button"
                title={gradient.label}
                onClick={() => setBackground("gradient", gradient.id)}
                className={cn("aspect-square rounded-[8px] border-2", scene.background.kind === "gradient" && scene.background.value === gradient.id ? "border-ember" : "border-transparent hover:border-white/25")}
                style={{ background: gradientCss(gradient) }}
              />
            ))}
          </div>
        )}
        {framed ? <Slider label="Background blur" value={scene.blur} min={0} max={8} step={0.25} format={(value) => `${value}px`} onChange={(blur) => liveScene({ blur })} onCommit={commit} /> : null}
      </Section>

      <Section title="Frame" onReset={() => setScene({ shadow: DEFAULT_SCENE.shadow, radius: DEFAULT_SCENE.radius, padding: DEFAULT_SCENE.padding })} advanced={advanced} onAdvanced={setAdvanced}>
        {!framed ? <p className="text-[12.5px] text-faint">Pick a background to frame the video with padding, corners and a shadow.</p> : null}
        <div className={cn("flex flex-col gap-4", !framed && "pointer-events-none opacity-40")}>
          <Slider label="Shadow" value={scene.shadow} min={0} max={1} step={0.01} format={(value) => `${Math.round(value * 100)}%`} onChange={(shadow) => liveScene({ shadow })} onCommit={commit} />
          <Slider label="Corners" value={scene.radius} min={0} max={0.5} step={0.005} format={(value) => `${Math.round(value * 100)}%`} onChange={(radius) => liveScene({ radius })} onCommit={commit} />
          {padding.linked || !advanced ? (
            <Slider
              label="Padding"
              value={Math.round(((padding.top + padding.bottom + padding.left + padding.right) / 4) * 400)}
              min={0}
              max={100}
              step={1}
              format={(value) => `${value}`}
              onChange={(value) => liveScene({ padding: { top: value / 400, bottom: value / 400, left: value / 400, right: value / 400, linked: true } })}
              onCommit={commit}
            />
          ) : (
            <>
              {(["top", "bottom"] as const).map((side) => (
                <Slider key={side} label={side === "top" ? "Top" : "Bottom"} value={Math.round(padding[side] * 400)} min={0} max={250} step={1} format={(value) => `${value}`} onChange={(value) => liveScene({ padding: { ...padding, [side]: value / 400 } })} onCommit={commit} />
              ))}
              {(["left", "right"] as const).map((side) => (
                <Slider key={side} label={side === "left" ? "Left" : "Right"} value={Math.round(padding[side] * 400)} min={0} max={100} step={1} format={(value) => `${value}`} onChange={(value) => liveScene({ padding: { ...padding, [side]: value / 400 } })} onCommit={commit} />
              ))}
            </>
          )}
          {advanced ? (
            <Toggle
              label="Link padding"
              hint="One value for all four sides"
              checked={padding.linked}
              onChange={(linked) => {
                const average = (padding.top + padding.bottom + padding.left + padding.right) / 4
                setScene({ padding: linked ? { top: average, bottom: average, left: average, right: average, linked } : { ...padding, linked } })
              }}
            />
          ) : null}
        </div>
      </Section>

      <Section title="Shape" onReset={() => setScene({ aspect: "native" })}>
        <Chips options={ASPECTS.map((aspect) => aspect.id)} value={ASPECTS.some((aspect) => aspect.id === scene.aspect) ? scene.aspect : "custom"} format={(id) => ASPECTS.find((aspect) => aspect.id === id)?.label || "Custom"} onChange={(aspect) => setScene({ aspect })} />
        <CustomAspect value={scene.aspect} onChange={(aspect) => setScene({ aspect })} />
      </Section>

      <Section title="Crop" onReset={() => setScene({ crop: { top: 0, bottom: 0, left: 0, right: 0 } })}>
        {(["top", "bottom", "left", "right"] as const).map((side) => (
          <Slider
            key={side}
            label={side[0].toUpperCase() + side.slice(1)}
            value={scene.crop[side]}
            min={0}
            max={0.45}
            step={0.005}
            format={(value) => `${Math.round(value * 100)}%`}
            onChange={(value) => liveScene({ crop: { ...scene.crop, [side]: value } })}
            onCommit={commit}
          />
        ))}
        {hasCamera ? null : null}
      </Section>
    </>
  )
}

function CustomAspect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value)
  const [w, setW] = useState(match?.[1] || "21")
  const [h, setH] = useState(match?.[2] || "9")
  return (
    <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
      Custom
      <Input className="h-8 w-16" value={w} onChange={(event) => setW(event.target.value.replace(/[^\d.]/g, ""))} />
      :
      <Input className="h-8 w-16" value={h} onChange={(event) => setH(event.target.value.replace(/[^\d.]/g, ""))} />
      <Button variant="pill" size="sm" className="h-8" disabled={!Number(w) || !Number(h)} onClick={() => onChange(`${Number(w)}:${Number(h)}`)}>
        Use
      </Button>
    </div>
  )
}

/* Cursor */

export function CursorPanel({ project, change, hasPointer, cursorHidden }: { project: EditProject; change: Change; hasPointer: boolean; cursorHidden: boolean }) {
  const [advanced, setAdvanced] = useState(false)
  const { live, commit } = useLive(change)
  const cursor = project.cursor
  const set = (changes: Partial<typeof cursor>) => change((current) => ({ ...current, cursor: { ...current.cursor, ...changes } }))
  const liveSet = (changes: Partial<typeof cursor>) => live((current) => ({ ...current, cursor: { ...current.cursor, ...changes } }))
  if (!hasPointer) return <Section title="Cursor"><p className="text-[12.5px] text-faint">This recording has no pointer data, so its cursor is part of the video.</p></Section>
  return (
    <>
      <Section title="Cursor" advanced={advanced} onAdvanced={setAdvanced} onReset={() => set(DEFAULT_CURSOR)}>
        {!cursorHidden ? <p className="text-[12px] text-faint">This recording also shows the real cursor. Turn on Smooth cursor in Settings for recordings without it.</p> : null}
        {advanced || !cursor.show ? <Toggle label="Show cursor" checked={cursor.show} onChange={(show) => set({ show })} /> : null}
        <div className="grid grid-cols-3 gap-1.5">
          {CURSOR_STYLES.map((style) => (
            <button
              key={style.id}
              type="button"
              onClick={() => set({ style: style.id, show: true })}
              className={cn("flex flex-col items-center gap-1 rounded-[10px] border-2 bg-white/[0.04] py-2 text-[11px]", cursor.style === style.id ? "border-ember" : "border-transparent hover:border-white/20")}
            >
              <img src={cursorSprite(style.id, "arrow").canvas.toDataURL()} alt="" className="h-7" />
              {style.label}
            </button>
          ))}
        </div>
        <Slider label="Size" value={cursor.size} min={0.5} max={10} step={0.1} format={(value) => `${value.toFixed(1)}×`} onChange={(size) => liveSet({ size })} onCommit={commit} />
        <Slider label="Smoothing" value={cursor.smoothing} min={0} max={2} step={0.01} format={(value) => value.toFixed(2)} onChange={(smoothing) => liveSet({ smoothing })} onCommit={commit} />
        <Slider label="Click bounce" value={cursor.bounce} min={0} max={5} step={0.1} format={(value) => `${value.toFixed(1)}×`} onChange={(bounce) => liveSet({ bounce })} onCommit={commit} />
        {advanced ? (
          <>
            <Slider label="Bounce speed" value={cursor.bounceSpeed} min={60} max={500} step={10} format={(value) => `${value} ms`} onChange={(bounceSpeed) => liveSet({ bounceSpeed })} onCommit={commit} />
            <Slider label="Sway" value={cursor.sway} min={0} max={2} step={0.05} format={(value) => value.toFixed(2)} onChange={(sway) => liveSet({ sway })} onCommit={commit} />
            <Toggle label="Loop cursor" hint="For looping GIFs: glides back to where it started" checked={cursor.loop} onChange={(loop) => set({ loop })} />
          </>
        ) : null}
      </Section>
      <Section title="Click effect" onReset={() => set({ effect: "off", effectColor: DEFAULT_CURSOR.effectColor, effectSize: 1, effectOpacity: 0.8, effectDuration: 600 })}>
        <Chips options={["off", "ripple", "spotlight", "echo"] as const} value={cursor.effect} format={(id) => id[0].toUpperCase() + id.slice(1)} onChange={(effect) => set({ effect })} />
        {cursor.effect !== "off" && advanced ? (
          <>
            <ColorField label="Colour" value={cursor.effectColor} options={["#2563eb", "#ff7a2f", "#ef4444", "#22c55e", "#eab308", "#a855f7", "#ffffff", "#000000"]} onChange={(effectColor) => effectColor && set({ effectColor })} />
            <Slider label="Size" value={cursor.effectSize} min={0.5} max={2} step={0.05} format={(value) => `${value.toFixed(2)}×`} onChange={(effectSize) => liveSet({ effectSize })} onCommit={commit} />
            <Slider label="Opacity" value={cursor.effectOpacity} min={0} max={1} step={0.01} format={(value) => `${Math.round(value * 100)}%`} onChange={(effectOpacity) => liveSet({ effectOpacity })} onCommit={commit} />
            <Slider label="Duration" value={cursor.effectDuration} min={120} max={1200} step={20} format={(value) => `${value} ms`} onChange={(effectDuration) => liveSet({ effectDuration })} onCommit={commit} />
          </>
        ) : cursor.effect !== "off" ? (
          <p className="text-[11.5px] text-faint">Turn on Advanced for colour, size, opacity and duration.</p>
        ) : null}
      </Section>
    </>
  )
}

/* Webcam */

const GRID: WebcamPosition[] = ["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"]
const GRID_ARROWS = ["↖", "↑", "↗", "←", "•", "→", "↙", "↓", "↘"]

export function WebcamPanel({ project, change, hasCamera, recorded }: { project: EditProject; change: Change; hasCamera: boolean; recorded: boolean }) {
  const [advanced, setAdvanced] = useState(false)
  const { live, commit } = useLive(change)
  const webcam = project.webcam
  const set = (changes: Partial<typeof webcam>) => change((current) => ({ ...current, webcam: { ...current.webcam, ...changes } }))
  const liveSet = (changes: Partial<typeof webcam>) => live((current) => ({ ...current, webcam: { ...current.webcam, ...changes } }))
  const upload = async () => {
    const asset = await window.meetingRecorder.editorPick("video")
    if (asset) set({ file: asset.url, show: true })
  }
  const footage = (
    <div className="flex gap-2">
      <Button variant="pill" size="sm" className="h-8" onClick={() => void upload()}>
        {webcam.file || recorded ? "Replace footage" : "Upload footage"}
      </Button>
      {webcam.file ? (
        <Button variant="ghost" size="sm" className="h-8" onClick={() => set({ file: null })}>
          {recorded ? "Use the recorded camera" : "Remove footage"}
        </Button>
      ) : null}
    </div>
  )
  if (!hasCamera)
    return (
      <Section title="Webcam">
        <p className="text-[12.5px] text-faint">This recording has no camera. Add a video of yourself to show in a bubble, or turn the camera on in the record card next time.</p>
        {footage}
      </Section>
    )
  return (
    <Section title="Webcam" advanced={advanced} onAdvanced={setAdvanced} onReset={() => set({ ...DEFAULT_WEBCAM, file: webcam.file })}>
      {footage}
      <Toggle label="Show" checked={webcam.show} onChange={(show) => set({ show })} />
      <Slider label="Size" value={Math.round(webcam.size * 100)} min={10} max={100} step={1} format={(value) => `${value}%`} onChange={(value) => liveSet(webcam.width && webcam.height ? { size: value / 100, width: (webcam.width * value) / 100 / webcam.size, height: (webcam.height * value) / 100 / webcam.size } : { size: value / 100, width: null, height: null })} onCommit={commit} />
      {advanced ? (
        <>
          <Slider label="Width" value={Math.round((webcam.width ?? webcam.size * 0.5) * 100)} min={5} max={100} step={1} format={(value) => `${value}%`} onChange={(value) => liveSet({ width: value / 100, height: webcam.height ?? webcam.size * 0.5 })} onCommit={commit} />
          <Slider label="Height" value={Math.round((webcam.height ?? webcam.size * 0.5) * 100)} min={5} max={100} step={1} format={(value) => `${value}%`} onChange={(value) => liveSet({ height: value / 100, width: webcam.width ?? webcam.size * 0.5 })} onCommit={commit} />
        </>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px]">Position</span>
        <div className="grid w-[132px] grid-cols-3 gap-1">
          {GRID.map((position, index) => (
            <button
              key={position}
              type="button"
              onClick={() => set({ position })}
              className={cn("flex size-10 items-center justify-center rounded-[8px] border text-[15px]", webcam.position === position ? "border-ember bg-ember/15 text-ember" : "border-white/10 text-muted-foreground hover:text-foreground")}
            >
              {GRID_ARROWS[index]}
            </button>
          ))}
        </div>
        {advanced ? (
          <>
            <Toggle label="Custom position" checked={webcam.position === "custom"} onChange={(on) => set({ position: on ? "custom" : "bottom-right" })} />
            {webcam.position === "custom" ? (
              <>
                <Slider label="Horizontal" value={Math.round(webcam.x * 100)} min={0} max={100} step={1} format={(value) => `${value}%`} onChange={(value) => liveSet({ x: value / 100 })} onCommit={commit} />
                <Slider label="Vertical" value={Math.round(webcam.y * 100)} min={0} max={100} step={1} format={(value) => `${value}%`} onChange={(value) => liveSet({ y: value / 100 })} onCommit={commit} />
              </>
            ) : null}
            <Slider label="Margin" value={webcam.margin} min={0} max={96} step={1} format={(value) => `${value}px`} onChange={(margin) => liveSet({ margin })} onCommit={commit} />
          </>
        ) : null}
      </div>
      <Slider label="Roundness" value={webcam.roundness} min={0} max={100} step={1} format={(value) => `${value}`} onChange={(roundness) => liveSet({ roundness })} onCommit={commit} />
      {advanced ? <Slider label="Shadow" value={webcam.shadow} min={0} max={1} step={0.01} format={(value) => `${Math.round(value * 100)}%`} onChange={(shadow) => liveSet({ shadow })} onCommit={commit} /> : null}
      <Toggle label="Mirror" checked={webcam.mirror} onChange={(mirror) => set({ mirror })} />
      <Toggle label="Reacts to zoom" hint="Changes size while the video is zoomed in" checked={webcam.reactsToZoom} onChange={(reactsToZoom) => set({ reactsToZoom })} />
      {webcam.reactsToZoom ? (
        <Slider
          label="Size while zoomed"
          value={Math.round((webcam.zoomSize ?? 0.75) * 100)}
          min={20}
          max={150}
          step={1}
          format={(value) => `${value}%`}
          onChange={(value) => liveSet({ zoomSize: value / 100 })}
          onCommit={commit}
        />
      ) : null}
      {advanced ? (
        <div className="flex flex-col gap-3 rounded-[10px] border border-border p-3">
          <span className="text-[12px] text-faint">Crop the camera</span>
          <Slider label="Left" value={Math.round(webcam.crop.x * 100)} min={0} max={45} step={1} format={(value) => `${value}%`} onChange={(value) => liveSet({ crop: { ...webcam.crop, x: value / 100, w: Math.min(webcam.crop.w, 1 - value / 100) } })} onCommit={commit} />
          <Slider label="Width" value={Math.round(webcam.crop.w * 100)} min={20} max={100} step={1} format={(value) => `${value}%`} onChange={(value) => liveSet({ crop: { ...webcam.crop, w: Math.min(value / 100, 1 - webcam.crop.x) } })} onCommit={commit} />
          <Slider label="Top" value={Math.round(webcam.crop.y * 100)} min={0} max={45} step={1} format={(value) => `${value}%`} onChange={(value) => liveSet({ crop: { ...webcam.crop, y: value / 100, h: Math.min(webcam.crop.h, 1 - value / 100) } })} onCommit={commit} />
          <Slider label="Height" value={Math.round(webcam.crop.h * 100)} min={20} max={100} step={1} format={(value) => `${value}%`} onChange={(value) => liveSet({ crop: { ...webcam.crop, h: Math.min(value / 100, 1 - webcam.crop.y) } })} onCommit={commit} />
        </div>
      ) : null}
    </Section>
  )
}

/* Captions */

export function CaptionsPanel({ project, change, transcriptReady, onGenerate }: { project: EditProject; change: Change; transcriptReady: boolean; onGenerate: () => void }) {
  const [advanced, setAdvanced] = useState(false)
  const { live, commit } = useLive(change)
  const style = project.captionStyle
  const set = (changes: Partial<typeof style>) => change((current) => ({ ...current, captionStyle: { ...current.captionStyle, ...changes } }))
  const liveSet = (changes: Partial<typeof style>) => live((current) => ({ ...current, captionStyle: { ...current.captionStyle, ...changes } }))
  return (
    <>
      <Section title="Captions">
        <p className="text-[12.5px] text-muted-foreground">Made from this recording's transcript, on this computer. Each word lights up as it's said.</p>
        <div className="flex gap-2">
          <Button className="h-9 flex-1 rounded-full" disabled={!transcriptReady} onClick={onGenerate}>
            {project.captions ? "Regenerate" : "Generate captions"}
          </Button>
          {project.captions ? (
            <Button variant="pill" className="h-9" onClick={() => change((current) => ({ ...current, captions: null }))}>
              Clear
            </Button>
          ) : null}
        </div>
        {!transcriptReady ? <p className="flex items-center gap-2 text-[12px] text-faint"><Spinner className="size-3" /> Waiting for the transcript…</p> : null}
        {project.captions ? <Toggle label="Show" checked={style.show} onChange={(show) => set({ show })} /> : null}
      </Section>
      {project.captions ? (
        <Section title="Style" advanced={advanced} onAdvanced={setAdvanced} onReset={() => set(DEFAULT_CAPTION_STYLE)}>
          <Slider label="Font size" value={style.fontSize} min={16} max={72} step={1} format={(value) => `${value}`} onChange={(fontSize) => liveSet({ fontSize })} onCommit={commit} />
          <ColorField label="Text colour" value={style.color} onChange={(color) => color && set({ color })} />
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px]">Animation</span>
            <Chips options={["off", "fade", "rise", "pop"] as const} value={style.animation} format={(id) => id[0].toUpperCase() + id.slice(1)} onChange={(animation) => set({ animation })} />
          </div>
          {advanced ? (
            <>
              <ColorField label="Not yet spoken" value={style.inactiveColor} options={["#a3a3a3", "#737373", "#ffffff", "#fde68a"]} onChange={(inactiveColor) => inactiveColor && set({ inactiveColor })} />
              <Slider label="Rows" value={style.rows} min={1} max={4} step={1} format={(value) => `${value}`} onChange={(rows) => liveSet({ rows })} onCommit={commit} />
              <Slider label="Bottom offset" value={Math.round(style.bottom * 100)} min={0} max={30} step={1} format={(value) => `${value}%`} onChange={(value) => liveSet({ bottom: value / 100 })} onCommit={commit} />
              <Slider label="Max width" value={Math.round(style.maxWidth * 100)} min={40} max={95} step={1} format={(value) => `${value}%`} onChange={(value) => liveSet({ maxWidth: value / 100 })} onCommit={commit} />
              <Slider label="Box radius" value={style.boxRadius} min={0} max={40} step={0.5} format={(value) => `${value}`} onChange={(boxRadius) => liveSet({ boxRadius })} onCommit={commit} />
              <Slider label="Background" value={Math.round(style.background * 100)} min={0} max={100} step={1} format={(value) => `${value}%`} onChange={(value) => liveSet({ background: value / 100 })} onCommit={commit} />
              <Toggle label="Hover to add on the timeline" checked={style.hoverAdd} onChange={(hoverAdd) => set({ hoverAdd })} />
            </>
          ) : null}
          <Toggle label="Save SRT and VTT files" hint="Beside the exported video" checked={style.sidecar} onChange={(sidecar) => set({ sidecar })} />
        </Section>
      ) : null}
    </>
  )
}

/* Context panels */

export function ZoomPanel({ project, change, id, hasPointer, onDelete }: { project: EditProject; change: Change; id: string; hasPointer: boolean; onDelete: () => void }) {
  const zoom = project.zooms.find((item) => item.id === id)
  if (!zoom) return null
  const set = (changes: Partial<typeof zoom>) => change((current) => ({ ...current, zooms: current.zooms.map((item) => (item.id === id ? { ...item, ...changes, suggested: false } : item)) }))
  return (
    <Section title="Zoom">
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px]">Depth</span>
        <Chips options={ZOOM_DEPTHS} value={zoom.depth} format={(depth) => `${depth}×`} onChange={(depth) => set({ depth })} />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px]">Follows</span>
        <Chips options={["auto", "manual"] as const} value={zoom.mode} format={(mode) => (mode === "auto" ? "The cursor" : "A spot")} onChange={(mode) => set({ mode })} />
        <p className="text-[11.5px] text-faint">
          {zoom.mode === "auto"
            ? hasPointer
              ? "Stays still until the cursor nears the edge, then moves just enough."
              : "This recording has no cursor data: drag the focus point on the preview instead."
            : "Drag the focus point on the preview."}
        </p>
      </div>
      {project.webcam.show && project.webcam.reactsToZoom ? (
        <div className="flex flex-col gap-1.5">
          <Slider
            label="Webcam size"
            value={Math.round((zoom.webcamSize ?? project.webcam.zoomSize ?? 0.75) * 100)}
            min={20}
            max={150}
            step={1}
            format={(value) => `${value}%${zoom.webcamSize == null ? " (default)" : ""}`}
            onChange={(value) =>
              change((current) => ({ ...current, zooms: current.zooms.map((item) => (item.id === id ? { ...item, webcamSize: value / 100, suggested: false } : item)) }), { live: true })
            }
            onCommit={() => change((current) => ({ ...current }))}
          />
          <p className="text-[11.5px] text-faint">
            How big the webcam is during this zoom.{" "}
            {zoom.webcamSize != null ? (
              <button type="button" className="text-ember hover:underline" onClick={() => set({ webcamSize: null })}>
                Use the default
              </button>
            ) : null}
          </p>
        </div>
      ) : null}
      <Button variant="destructive" className="h-9 justify-start" onClick={onDelete}>
        <HugeiconsIcon icon={Delete02Icon} strokeWidth={1.7} /> Remove zoom
      </Button>
    </Section>
  )
}

export function ClipPanel({ project, change, index, onSeparateAudio }: { project: EditProject; change: Change; index: number; onSeparateAudio?: () => void }) {
  const clip = project.clips[index]
  const [speed, setSpeed] = useState(clip?.speed ?? 1)
  useEffect(() => setSpeed(clip?.speed ?? 1), [clip?.speed])
  if (!clip) return null
  return (
    <Section title={`Clip ${index + 1}`} onReset={() => change((current) => updateClip(current, index, { speed: 1, muted: false }))}>
      <Slider label="Speed" value={speed} min={SPEED_MIN} max={SPEED_MAX} step={0.25} format={(value) => `${value}×`} onChange={setSpeed} onCommit={() => change((current) => updateClip(current, index, { speed }))} />
      <Toggle label="Mute clip" checked={clip.muted} onChange={(muted) => change((current) => updateClip(current, index, { muted }))} />
      {onSeparateAudio ? (
        <Button variant="pill" className="h-9 justify-start" disabled={clip.speed !== 1 || clip.muted} onClick={onSeparateAudio} title={clip.speed !== 1 ? "Only at 1× speed" : undefined}>
          Separate audio
        </Button>
      ) : null}
      <Button variant="destructive" className="h-9 justify-start" disabled={project.clips.length <= 1} onClick={() => change((current) => deleteClip(current, index))}>
        <HugeiconsIcon icon={Delete02Icon} strokeWidth={1.7} /> Delete clip
      </Button>
    </Section>
  )
}

export function AudioPanel({ project, change, id }: { project: EditProject; change: Change; id: string }) {
  const block = project.audio.find((item) => item.id === id)
  const { live, commit } = useLive(change)
  if (!block) return null
  const set = (changes: Partial<typeof block>) => change((current) => ({ ...current, audio: current.audio.map((item) => (item.id === id ? { ...item, ...changes } : item)) }))
  return (
    <Section title={block.name}>
      <Slider label="Volume" value={block.volume} min={0} max={1} step={0.01} format={(value) => `${Math.round(value * 100)}%`} onChange={(volume) => live((current) => ({ ...current, audio: current.audio.map((item) => (item.id === id ? { ...item, volume } : item)) }))} onCommit={commit} />
      <Toggle label="Normalize" hint="A little louder, for quiet music" checked={block.normalize} onChange={(normalize) => set({ normalize })} />
      <Button variant="destructive" className="h-9 justify-start" onClick={() => change((current) => ({ ...current, audio: current.audio.filter((item) => item.id !== id) }))}>
        <HugeiconsIcon icon={Delete02Icon} strokeWidth={1.7} /> Remove audio
      </Button>
    </Section>
  )
}

export function SoundPanel({ project, change, hasSystem }: { project: EditProject; change: Change; hasSystem: boolean }) {
  const { live, commit } = useLive(change)
  const sound = project.sound
  return (
    <Section title="Recording's sound" onReset={() => change((current) => ({ ...current, sound: { ...current.sound, volume: 1, systemVolume: 1, normalize: false } }))}>
      <Slider label={hasSystem ? "Microphone" : "Volume"} value={sound.volume} min={0} max={1} step={0.01} format={(value) => `${Math.round(value * 100)}%`} onChange={(volume) => live((current) => ({ ...current, sound: { ...current.sound, volume } }))} onCommit={commit} />
      {hasSystem ? (
        <Slider label="System audio" value={sound.systemVolume} min={0} max={1} step={0.01} format={(value) => `${Math.round(value * 100)}%`} onChange={(systemVolume) => live((current) => ({ ...current, sound: { ...current.sound, systemVolume } }))} onCommit={commit} />
      ) : null}
      <p className="text-[11.5px] text-faint">Add music or other sound with Add layer → Audio track on the timeline.</p>
      <Toggle label="Normalize" hint="Brings a quiet recording up" checked={sound.normalize} onChange={(normalize) => change((current) => ({ ...current, sound: { ...current.sound, normalize } }))} />
    </Section>
  )
}

export function CaptionPanel({ project, change, id, playhead }: { project: EditProject; change: Change; id: string; playhead: number }) {
  const captions = project.captions || []
  const index = captions.findIndex((caption) => caption.id === id)
  const caption = captions[index]
  const [text, setText] = useState(caption?.text || "")
  useEffect(() => setText(caption?.text || ""), [caption?.text])
  if (!caption) return null
  const replace = (next: Caption[]) => change((current) => ({ ...current, captions: next }))
  return (
    <Section title="Caption">
      <Textarea value={text} onChange={(event) => setText(event.target.value)} onBlur={() => text !== caption.text && replace(captions.map((item) => (item.id === id ? retextCaption(item, text) : item)))} className="min-h-20 text-[13.5px]" />
      <div className="grid grid-cols-2 gap-2">
        {(["start", "end"] as const).map((edge) => (
          <label key={edge} className="flex flex-col gap-1 text-[12px] text-faint">
            {edge === "start" ? "Start (s)" : "End (s)"}
            <Input
              type="number"
              step={0.1}
              defaultValue={caption[edge].toFixed(2)}
              key={`${caption.id}-${caption[edge]}`}
              onBlur={(event) => {
                const value = Number(event.target.value)
                if (!Number.isFinite(value)) return
                const start = edge === "start" ? Math.min(value, caption.end - 0.2) : caption.start
                const end = edge === "end" ? Math.max(value, caption.start + 0.2) : caption.end
                replace(captions.map((item) => (item.id === id ? retimeCaption(item, start, end) : item)))
              }}
              className="h-8"
            />
          </label>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="pill"
          size="sm"
          disabled={!(playhead > caption.start && playhead < caption.end)}
          onClick={() => {
            const parts = splitCaption(caption, playhead)
            if (parts) replace([...captions.slice(0, index), ...parts, ...captions.slice(index + 1)])
          }}
        >
          Split at playhead
        </Button>
        <Button
          variant="pill"
          size="sm"
          disabled={index >= captions.length - 1}
          onClick={() => replace([...captions.slice(0, index), mergeCaptions(caption, captions[index + 1]), ...captions.slice(index + 2)])}
        >
          Merge with next
        </Button>
        <Button variant="destructive" size="sm" onClick={() => replace(captions.filter((item) => item.id !== id))}>
          Delete
        </Button>
      </div>
    </Section>
  )
}

const DIRECTIONS: { id: ArrowDirection; icon: typeof ArrowUp01Icon }[] = [
  { id: "up-left", icon: ArrowUpLeft01Icon },
  { id: "up", icon: ArrowUp01Icon },
  { id: "up-right", icon: ArrowUpRight01Icon },
  { id: "left", icon: ArrowLeft01Icon },
  { id: "right", icon: ArrowRight01Icon },
  { id: "down-left", icon: ArrowDownLeft01Icon },
  { id: "down", icon: ArrowDown01Icon },
  { id: "down-right", icon: ArrowDownRight01Icon },
]

export function AnnotationPanel({
  project,
  change,
  id,
  fonts = [],
  onAddFont,
}: {
  project: EditProject
  change: Change
  id: string
  fonts?: { name: string; family: string }[]
  onAddFont?: (link: string, name: string) => Promise<void>
}) {
  const [fontForm, setFontForm] = useState<{ link: string; name: string; error: string; busy: boolean } | null>(null)
  const annotation = project.annotations.find((item) => item.id === id)
  const { live, commit } = useLive(change)
  const [text, setText] = useState(annotation?.text || "")
  useEffect(() => setText(annotation?.text || ""), [annotation?.id, annotation?.text])
  if (!annotation) return null
  const set = (changes: Partial<Annotation>) => change((current) => ({ ...current, annotations: current.annotations.map((item) => (item.id === id ? { ...item, ...changes } : item)) }))
  const liveSet = (changes: Partial<Annotation>) => live((current) => ({ ...current, annotations: current.annotations.map((item) => (item.id === id ? { ...item, ...changes } : item)) }))
  const pickImage = async () => {
    const asset = await window.meetingRecorder.editorPick("image")
    if (asset) set({ image: asset.url })
  }
  return (
    <Section title="Annotation">
      <Chips options={["text", "image", "arrow", "blur"] as const} value={annotation.kind} format={(kind) => kind[0].toUpperCase() + kind.slice(1)} onChange={(kind) => set({ kind })} />
      {annotation.kind === "text" ? (
        <>
          <Textarea value={text} onChange={(event) => setText(event.target.value)} onBlur={() => text !== annotation.text && set({ text })} className="min-h-20 text-[13.5px]" />
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px]">Font</span>
            <select value={annotation.font} onChange={(event) => set({ font: event.target.value })} className="h-9 rounded-md border border-border bg-transparent px-2 text-[13px]">
              {Object.keys(FONTS).map((font) => (
                <option key={font} value={font}>
                  {font[0].toUpperCase() + font.slice(1)}
                </option>
              ))}
              {fonts.map((font) => (
                <option key={font.family} value={font.family}>
                  {font.name}
                </option>
              ))}
            </select>
            {onAddFont ? (
              fontForm ? (
                <div className="flex flex-col gap-2 rounded-[10px] border border-border p-2.5">
                  <Input placeholder="https://fonts.googleapis.com/css2?family=…" value={fontForm.link} onChange={(event) => setFontForm({ ...fontForm, link: event.target.value, error: "" })} className="h-8 text-[12px]" />
                  <Input placeholder="Name to show" value={fontForm.name} onChange={(event) => setFontForm({ ...fontForm, name: event.target.value })} className="h-8 text-[12px]" />
                  {fontForm.error ? <p className="text-[11.5px] text-rec">{fontForm.error}</p> : null}
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="h-8 rounded-full"
                      disabled={!fontForm.link.trim() || fontForm.busy}
                      onClick={async () => {
                        setFontForm({ ...fontForm, busy: true })
                        try {
                          await onAddFont(fontForm.link, fontForm.name)
                          setFontForm(null)
                        } catch (error) {
                          setFontForm({ ...fontForm, busy: false, error: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error) })
                        }
                      }}
                    >
                      {fontForm.busy ? <Spinner /> : null} Add font
                    </Button>
                    <Button size="sm" variant="ghost" className="h-8" onClick={() => setFontForm(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <button type="button" className="self-start text-[12px] text-faint hover:text-foreground" onClick={() => setFontForm({ link: "", name: "", error: "", busy: false })}>
                  Add a Google Font…
                </button>
              )
            ) : null}
          </div>
          <Slider label="Size" value={annotation.size} min={12} max={128} step={1} format={(value) => `${value}px`} onChange={(size) => liveSet({ size })} onCommit={commit} />
          <div className="flex gap-1">
            {[
              { key: "bold", icon: TextBoldIcon },
              { key: "italic", icon: TextItalicIcon },
              { key: "underline", icon: TextUnderlineIcon },
            ].map((item) => (
              <Button key={item.key} variant={annotation[item.key as "bold"] ? "secondary" : "ghost"} size="icon-sm" onClick={() => set({ [item.key]: !annotation[item.key as "bold"] })}>
                <HugeiconsIcon icon={item.icon} strokeWidth={1.8} />
              </Button>
            ))}
            <span className="mx-1 w-px bg-border" />
            {[
              { key: "left", icon: AlignLeftIcon },
              { key: "center", icon: TextAlignCenterIcon },
              { key: "right", icon: AlignRightIcon },
            ].map((item) => (
              <Button key={item.key} variant={annotation.align === item.key ? "secondary" : "ghost"} size="icon-sm" onClick={() => set({ align: item.key as Annotation["align"] })}>
                <HugeiconsIcon icon={item.icon} strokeWidth={1.8} />
              </Button>
            ))}
          </div>
          <ColorField label="Text colour" value={annotation.color} onChange={(color) => color && set({ color })} />
          <ColorField label="Background" value={annotation.background} allowNone onChange={(background) => set({ background })} />
          {annotation.background ? <Slider label="Corner radius" value={annotation.radius} min={0} max={48} step={1} format={(value) => `${value}`} onChange={(radius) => liveSet({ radius })} onCommit={commit} /> : null}
        </>
      ) : annotation.kind === "image" ? (
        <>
          {annotation.image ? <img src={annotation.image} alt="" className="max-h-28 self-start rounded-[8px] object-contain" /> : null}
          <Button variant="pill" className="h-9" onClick={() => void pickImage()}>
            {annotation.image ? "Change picture" : "Choose a picture"}
          </Button>
        </>
      ) : annotation.kind === "arrow" ? (
        <>
          <div className="grid w-[132px] grid-cols-3 gap-1">
            {DIRECTIONS.slice(0, 4).map((item) => (
              <Button key={item.id} variant={annotation.direction === item.id ? "secondary" : "ghost"} size="icon" onClick={() => set({ direction: item.id })}>
                <HugeiconsIcon icon={item.icon} strokeWidth={1.8} />
              </Button>
            ))}
            <span />
            {DIRECTIONS.slice(4).map((item) => (
              <Button key={item.id} variant={annotation.direction === item.id ? "secondary" : "ghost"} size="icon" onClick={() => set({ direction: item.id })}>
                <HugeiconsIcon icon={item.icon} strokeWidth={1.8} />
              </Button>
            ))}
          </div>
          <Slider label="Thickness" value={annotation.stroke} min={1} max={6} step={0.5} format={(value) => `${value}px`} onChange={(stroke) => liveSet({ stroke })} onCommit={commit} />
          <ColorField label="Colour" value={annotation.color} onChange={(color) => color && set({ color })} />
        </>
      ) : (
        <>
          <Slider label="Strength" value={annotation.strength} min={1} max={100} step={1} format={(value) => `${value}`} onChange={(strength) => liveSet({ strength })} onCommit={commit} />
          <Slider label="Corner radius" value={annotation.radius} min={0} max={48} step={1} format={(value) => `${value}`} onChange={(radius) => liveSet({ radius })} onCommit={commit} />
          <ColorField label="Cover with a colour" value={annotation.fill} allowNone onChange={(fill) => set({ fill })} />
        </>
      )}
      <p className="text-[11.5px] text-faint">Drag it on the preview to move it, or by its corner to resize. Tab cycles through notes at the playhead.</p>
      <Button variant="destructive" className="h-9 justify-start" onClick={() => change((current) => ({ ...current, annotations: current.annotations.filter((item) => item.id !== id) }))}>
        <HugeiconsIcon icon={Delete02Icon} strokeWidth={1.7} /> Delete annotation
      </Button>
    </Section>
  )
}

/* Settings */

export function SettingsPanel({
  project,
  change,
  previewVolume,
  onPreviewVolume,
  autoZooms,
  onAutoZooms,
  onShortcuts,
}: {
  project: EditProject
  change: Change
  previewVolume: number
  onPreviewVolume: (value: number) => void
  autoZooms: boolean
  onAutoZooms: (value: boolean) => void
  onShortcuts: () => void
}) {
  const motion = project.motion
  const set = (changes: Partial<typeof motion>) => change((current) => ({ ...current, motion: { ...current.motion, ...changes } }))
  return (
    <>
      <Section title="Motion">
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px]">Motion preset</span>
          <Chips options={["focused", "smooth"] as const} value={motion.preset} format={(preset) => (preset === "focused" ? "Focused" : "Smooth")} onChange={(preset) => set({ preset })} />
          <p className="text-[11.5px] text-faint">{motion.preset === "focused" ? "Quick, snappy zooms." : "Slow, gliding zooms."}</p>
        </div>
        <Toggle label="Connect zooms" hint="Zooms close together glide from one to the next" checked={motion.connect} onChange={(connect) => set({ connect })} />
        <Toggle label="Classic animation" hint="Eased zooms without spring motion" checked={motion.classic} onChange={(classic) => set({ classic })} />
        <Toggle label="Motion blur" hint="On fast pans, zooms and cursor moves" checked={motion.blur !== false} onChange={(blur) => set({ blur })} />
        {motion.blur !== false ? (
          <Slider
            label="Blur strength"
            value={Math.round((motion.blurStrength ?? 0.35) * 100)}
            min={5}
            max={100}
            step={1}
            format={(value) => `${value}%`}
            onChange={(value) => change((current) => ({ ...current, motion: { ...current.motion, blurStrength: value / 100 } }), { live: true })}
            onCommit={() => change((current) => ({ ...current }))}
          />
        ) : null}
        <Toggle label="Suggest zooms for new recordings" hint="Zooms on your clicks when a recording opens" checked={autoZooms} onChange={onAutoZooms} />
      </Section>
      <Section title="Preview">
        <Slider label="Preview volume" value={previewVolume} min={0} max={1} step={0.01} format={(value) => `${Math.round(value * 100)}%`} onChange={onPreviewVolume} />
        <Button variant="pill" className="h-9" onClick={onShortcuts}>
          Keyboard shortcuts…
        </Button>
      </Section>
    </>
  )
}

export { clamp }

/* Clips from other recordings */

export function ClipsPanel({ project, change, currentId }: { project: EditProject; change: Change; currentId: string }) {
  const [items, setItems] = useState<import("@/types/bridge").RecordingSummary[] | null>(null)
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  useEffect(() => {
    const load = () => void window.meetingRecorder.recordingsList(query).then((list) => setItems(list.filter((item) => item.id !== currentId)))
    load()
    return window.meetingRecorder.onRecordingsChanged(load)
  }, [query, currentId])
  const add = (item: import("@/types/bridge").RecordingSummary) =>
    change((current) => ({
      ...current,
      clips: [
        ...current.clips,
        { id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, start: 0, end: item.duration, speed: 1, muted: false, source: { id: item.id, title: item.title, width: item.width || 1920, height: item.height || 1080, duration: item.duration } },
      ],
    }))
  return (
    <Section title="Clips">
      <p className="text-[12.5px] text-muted-foreground">Add another recording to the end of this one. It plays at its own shape, letterboxed.</p>
      <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search recordings" className="h-9" />
      {selected.size ? (
        <div className="flex items-center gap-2 text-[12px]">
          {selected.size} selected
          <button type="button" className="text-faint hover:text-foreground" onClick={() => setSelected(new Set((items || []).map((item) => item.id)))}>
            Select all
          </button>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto hover:text-rec"
            onClick={async () => {
              for (const id of selected) if (!project.clips.some((clip) => clip.source?.id === id)) await window.meetingRecorder.removeRecording(id)
              setSelected(new Set())
            }}
          >
            Move to Trash
          </Button>
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        {items === null ? <Spinner /> : null}
        {(items || []).map((item) => (
          <div key={item.id} className="flex items-center gap-2.5 rounded-[10px] border border-border p-2">
            <input
              type="checkbox"
              checked={selected.has(item.id)}
              onChange={() =>
                setSelected((current) => {
                  const next = new Set(current)
                  if (next.has(item.id)) next.delete(item.id)
                  else next.add(item.id)
                  return next
                })
              }
              className="accent-[var(--ember)]"
            />
            {item.hasThumb ? <img src={`ember-media://recording/${item.id}/thumb`} alt="" className="h-9 w-16 shrink-0 rounded object-cover" /> : <span className="h-9 w-16 shrink-0 rounded bg-white/5" />}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px]">{item.title}</span>
              <span className="text-[11px] text-faint tabular">
                {Math.floor(item.duration / 60)}:{String(Math.floor(item.duration % 60)).padStart(2, "0")}
              </span>
            </span>
            <Button variant="pill" size="sm" className="h-7 shrink-0 px-2.5 text-[12px]" onClick={() => add(item)}>
              Add
            </Button>
          </div>
        ))}
        {items && !items.length ? <p className="text-[12px] text-faint">No other recordings yet.</p> : null}
      </div>
    </Section>
  )
}

/* Layout */

const LAYOUTS: { id: LayoutPreset; label: string; hint: string; camera: boolean }[] = [
  { id: "bubble", label: "Bubble", hint: "The camera in a bubble over the screen", camera: false },
  { id: "side-by-side", label: "Side by side", hint: "Camera on the left third, screen on the rest. For sales videos", camera: true },
  { id: "side-by-side-right", label: "Side by side, camera right", hint: "Screen on the left, camera on the right third", camera: true },
  { id: "stacked", label: "Stacked", hint: "Camera on top, screen below, for vertical video", camera: true },
  { id: "camera", label: "Camera only", hint: "Just you, full frame", camera: true },
  { id: "screen", label: "Screen only", hint: "Just the screen, no camera", camera: false },
]

/** A tiny drawing of each layout: orange for the camera, grey for the screen. */
function LayoutThumb({ id }: { id: LayoutPreset }) {
  const camera = "bg-ember/80"
  const screen = "bg-white/25"
  const tall = id === "stacked"
  return (
    <span className={cn("relative flex shrink-0 overflow-hidden rounded-[4px] border border-white/15 bg-black/40", tall ? "h-[42px] w-[24px] flex-col" : "h-[27px] w-[48px]")}>
      {id === "bubble" ? (
        <>
          <span className={cn("absolute inset-0", screen)} />
          <span className={cn("absolute right-1 bottom-1 size-2.5 rounded-full", camera)} />
        </>
      ) : id === "side-by-side" ? (
        <>
          <span className={cn("w-1/3", camera)} />
          <span className={cn("flex-1", screen)} />
        </>
      ) : id === "side-by-side-right" ? (
        <>
          <span className={cn("flex-1", screen)} />
          <span className={cn("w-1/3", camera)} />
        </>
      ) : id === "stacked" ? (
        <>
          <span className={cn("h-1/3", camera)} />
          <span className={cn("flex-1", screen)} />
        </>
      ) : id === "camera" ? (
        <span className={cn("flex-1", camera)} />
      ) : (
        <span className={cn("flex-1", screen)} />
      )}
    </span>
  )
}

export function LayoutPanel({ project, change, hasCamera }: { project: EditProject; change: Change; hasCamera: boolean }) {
  const { live, commit } = useLive(change)
  const layout = project.layout
  const set = (changes: Partial<typeof layout>) => change((current) => ({ ...current, layout: { ...current.layout, ...changes } }))
  const liveSet = (changes: Partial<typeof layout>) => live((current) => ({ ...current, layout: { ...current.layout, ...changes } }))
  const split = layout.preset === "side-by-side" || layout.preset === "side-by-side-right" || layout.preset === "stacked"
  const cropsScreen = split
  return (
    <>
      <Section title="Layout" onReset={() => set(DEFAULT_LAYOUT)}>
        <div className="flex flex-col gap-1.5">
          {LAYOUTS.map((item) => {
            const disabled = item.camera && !hasCamera
            return (
              <button
                key={item.id}
                type="button"
                disabled={disabled}
                onClick={() =>
                  change((current) => ({
                    ...current,
                    layout: { ...current.layout, preset: item.id },
                    // Split layouts make their own frame shape.
                    scene: item.id === "bubble" || item.id === "screen" ? current.scene : { ...current.scene, aspect: "native" },
                  }))
                }
                className={cn(
                  "flex items-center gap-3 rounded-[10px] border px-3 py-2.5 text-left disabled:opacity-40",
                  layout.preset === item.id ? "border-ember bg-ember/[0.08]" : "border-white/[0.08] hover:border-white/20",
                )}
              >
                <span className="flex w-[48px] justify-center">
                  <LayoutThumb id={item.id} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px]">{item.label}</span>
                  <span className="block text-[11.5px] text-faint">{disabled ? "Needs a camera: record with it on, or add footage in Webcam" : item.hint}</span>
                </span>
              </button>
            )
          })}
        </div>
      </Section>
      {split ? (
        <Section title="Split">
          <Slider
            label="Camera's share"
            value={Math.round(layout.split * 100)}
            min={20}
            max={60}
            step={1}
            format={(value) => (value === 33 ? "A third" : `${value}%`)}
            onChange={(value) => liveSet({ split: value / 100 })}
            onCommit={commit}
          />
          <Button variant="ghost" size="sm" className="self-start" onClick={() => set({ split: 1 / 3 })}>
            Back to a third
          </Button>
        </Section>
      ) : null}
      {cropsScreen ? (
        <Section title="Screen">
          <p className="text-[12px] text-faint">The screen is cropped to fit its part of the frame. Choose which part shows; zooms still work inside it.</p>
          <Slider label="Left to right" value={Math.round(layout.screenX * 100)} min={0} max={100} step={1} format={(value) => (value === 0 ? "Left edge" : value === 100 ? "Right edge" : value === 50 ? "Centre" : `${value}%`)} onChange={(value) => liveSet({ screenX: value / 100 })} onCommit={commit} />
          <p className="text-[11.5px] text-faint">To frame yourself, crop the camera in Webcam → Advanced.</p>
        </Section>
      ) : null}
    </>
  )
}
