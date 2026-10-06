import { describe, expect, test } from "bun:test"

import { captionsFromTranscript, captionsVtt, mergeCaptions, splitCaption } from "./captions"
import {
  addZoom,
  deleteClip,
  editedDuration,
  freeSlots,
  isUnedited,
  moveClip,
  newAnnotation,
  newProject,
  normalizeProject,
  snapTime,
  splitAt,
  toEdited,
  toSource,
  trimClip,
  updateClip,
  type EditProject,
} from "./model"
import { FPS, cameraTrack, cursorTrack, suggestZooms, zoomMoments } from "./motion"
import { aspectRatio, layoutFor, outputSize } from "./scene"
import { frameState, motionFor } from "./render"

const clicks = [
  [0, 0.5, 0.5, 0, 0],
  [2, 0.2, 0.3, 1, 2],
  [2.1, 0.2, 0.3, 0, 2],
  [3, 0.25, 0.35, 1, 0],
  [3.1, 0.25, 0.35, 0, 0],
  [12, 0.8, 0.7, 1, 0],
  [12.1, 0.8, 0.7, 0, 0],
]

const base = (duration = 60) => newProject(duration, null)

describe("clips, back to back", () => {
  test("split, delete, speed and the edited length", () => {
    let project = splitAt(splitAt(base(), 10), 20)
    expect(project.clips.map((clip) => [clip.start, clip.end])).toEqual([[0, 10], [10, 20], [20, 60]])
    project = deleteClip(project, 1)
    expect(editedDuration(project)).toBe(50)
    project = updateClip(project, 1, { speed: 2 })
    expect(editedDuration(project)).toBe(30)
    expect(toEdited(project, 15)).toBeNull()
    expect(toEdited(project, 30)).toBe(15)
    expect(toSource(project, 15)).toBe(30)
    expect(deleteClip(base(), 0).clips.length).toBe(1)
  })
  test("reordering plays a later moment first", () => {
    const project = moveClip(splitAt(base(30), 10), 1, 0)
    expect(project.clips.map((clip) => clip.start)).toEqual([10, 0])
    expect(toSource(project, 0)).toBe(10)
    expect(toEdited(project, 5)).toBe(25)
  })
  test("trimming closes up, within the recording", () => {
    let project = trimClip(base(), 0, "start", 5, 60)
    expect(project.clips[0].start).toBe(5)
    project = trimClip(project, 0, "end", 200, 60)
    expect(project.clips[0].end).toBe(60)
    expect(trimClip(project, 0, "start", 59.99, 60).clips[0].start).toBeCloseTo(59.8)
  })
  test("speed snaps to quarter steps and stays in range", () => {
    expect(updateClip(base(), 0, { speed: 1.3 }).clips[0].speed).toBe(1.25)
    expect(updateClip(base(), 0, { speed: 99 }).clips[0].speed).toBe(4)
  })
})

describe("everything else moves with its moment", () => {
  test("a note after a deleted clip moves up; one in a deleted clip stays at the cut", () => {
    let project: EditProject = splitAt(base(), 10)
    const after = { ...newAnnotation("text", 30), id: "after" }
    const inside = { ...newAnnotation("text", 5), id: "inside" }
    project = { ...project, annotations: [after, inside], zooms: [{ id: "z", start: 4, end: 6, depth: 2, mode: "auto", x: 0.5, y: 0.5, suggested: false }] }
    project = deleteClip(project, 0)
    expect(project.annotations.find((item) => item.id === "after")!.start).toBe(20)
    expect(project.annotations.find((item) => item.id === "inside")!.start).toBe(0)
    expect(project.zooms).toEqual([])
  })
  test("reordering carries a note with its clip", () => {
    let project: EditProject = splitAt(base(30), 10)
    project = { ...project, markers: [{ id: "m", time: 15 }] }
    project = moveClip(project, 1, 0)
    expect(project.markers[0].time).toBe(5)
  })
})

describe("timeline helpers", () => {
  test("free slots and snapping", () => {
    const zooms = [{ id: "a", start: 2, end: 5, depth: 2, mode: "auto" as const, x: 0, y: 0, suggested: false }]
    expect(freeSlots(zooms, 10, 1)).toEqual([[0, 2], [5, 10]])
    expect(snapTime(4.96, [5, 8], 0.1)).toBe(5)
    expect(snapTime(4.5, [5, 8], 0.1)).toBe(4.5)
    const added = addZoom(base(), 59.5)
    expect(added.project.zooms[0].end).toBeLessThanOrEqual(60)
  })
  test("a fresh edit counts as unedited", () => {
    expect(isUnedited(base(), 60)).toBe(true)
    expect(isUnedited(splitAt(base(), 10), 60)).toBe(false)
  })
})

describe("reading edits", () => {
  test("the first version's edits are converted", () => {
    const old = {
      segments: [{ start: 0, end: 10, speed: 1, removed: true }, { start: 10, end: 40, speed: 2, removed: false }],
      zooms: [{ start: 20, end: 24, scale: 2, x: 0.3, y: 0.4, follow: false, auto: false }],
      look: { background: "ember", padding: 0.06, radius: 0.03, shadow: true, aspect: "1:1" },
    }
    const project = normalizeProject(old, 40)!
    expect(project.clips.map((clip) => [clip.start, clip.end, clip.speed])).toEqual([[10, 40, 2]])
    expect(project.zooms[0].start).toBe(5)
    expect(project.zooms[0].mode).toBe("manual")
    expect(project.scene.background).toEqual({ kind: "gradient", value: "ember" })
    expect(project.scene.aspect).toBe("1:1")
  })
  test("bad files are repaired or refused", () => {
    expect(normalizeProject(null, 10)).toBeNull()
    expect(normalizeProject({ version: 2, clips: [] }, 10)).toBeNull()
    const repaired = normalizeProject({ version: 2, clips: [{ start: -3, end: 99, speed: 50 }], scene: { radius: 9, aspect: "nonsense" } }, 20)!
    expect(repaired.clips[0]).toMatchObject({ start: 0, end: 20, speed: 4 })
    expect(repaired.scene.radius).toBe(0.5)
    expect(repaired.scene.aspect).toBe("native")
  })
})

describe("motion", () => {
  test("zoom suggestions from clicks and rests, placed where there's room", () => {
    const moments = zoomMoments(clicks, 30)
    expect(moments[0].start).toBeCloseTo(1.5)
    expect(moments[0].x).toBeCloseTo(0.225)
    const zooms = suggestZooms(base(30), clicks, 30)
    expect(zooms.length).toBeGreaterThanOrEqual(2)
    expect(zooms.every((zoom) => zoom.suggested && zoom.depth === 1.8)).toBe(true)
  })
  test("the camera springs in for a zoom and out after it", () => {
    const project: EditProject = { ...base(10), zooms: [{ id: "z", start: 3, end: 6, depth: 2, mode: "manual", x: 0.8, y: 0.2, suggested: false }] }
    const track = cameraTrack(project, [])
    expect(track.length).toBe(10 * FPS + 1)
    expect(track[0].scale).toBe(1)
    expect(track[Math.round(5.5 * FPS)].scale).toBeGreaterThan(1.8)
    expect(track[Math.round(9.9 * FPS)].scale).toBeLessThan(1.1)
    // A manual zoom never shows past the edge: x is kept within the view.
    expect(track[Math.round(5.5 * FPS)].x).toBeLessThanOrEqual(0.75 + 0.01)
    const classic = cameraTrack({ ...project, motion: { ...project.motion, classic: true } }, [])
    expect(classic[Math.round(5 * FPS)].scale).toBeCloseTo(2, 1)
  })
  test("connected zooms stay in between", () => {
    const zooms = [
      { id: "a", start: 1, end: 3, depth: 2, mode: "manual" as const, x: 0.3, y: 0.3, suggested: false },
      { id: "b", start: 4, end: 6, depth: 2, mode: "manual" as const, x: 0.7, y: 0.7, suggested: false },
    ]
    const connected = cameraTrack({ ...base(10), zooms }, [])
    const separate = cameraTrack({ ...base(10), zooms, motion: { preset: "smooth", classic: false, connect: false, blur: true, blurStrength: 0.35 } }, [])
    expect(connected[Math.round(3.4 * FPS)].scale).toBeGreaterThan(separate[Math.round(3.4 * FPS)].scale)
  })
  test("the cursor follows, squashes on a click, and loops if asked", () => {
    const project = base(15)
    const { frames, clicks: found } = cursorTrack(project, clicks)
    expect(found.length).toBe(3)
    expect(frames[Math.round(2.1 * FPS)].squash).toBeLessThan(1)
    expect(frames[Math.round(2.05 * FPS)].shape).toBe(2)
    const looped = cursorTrack({ ...project, cursor: { ...project.cursor, loop: true } }, clicks).frames
    expect(looped[looped.length - 1].x).toBeCloseTo(looped[0].x, 3)
  })
})

describe("scene", () => {
  test("sizes and padding", () => {
    const scene = { ...base().scene, background: { kind: "gradient" as const, value: "ember" }, aspect: "9:16" }
    expect(outputSize(scene, 2560, 1440, "1080")).toEqual({ width: 1080, height: 1920 })
    expect(outputSize({ ...scene, aspect: "native" }, 3024, 1964, "original")).toEqual({ width: 3024, height: 1964 })
    expect(outputSize({ ...scene, aspect: "native" }, 3024, 1964, "medium").width).toBe(2268)
    const layout = layoutFor(scene, 1080, 1920, 1920, 1080)
    expect(layout.content.w).toBeLessThan(1080)
    expect(layout.shadows.length).toBe(3)
    expect(layoutFor({ ...scene, background: { kind: "none", value: "" } }, 1080, 1920, 1920, 1080).content.w).toBe(1080)
  })
  test("crop changes the native shape", () => {
    const scene = { ...base().scene, crop: { top: 0, bottom: 0, left: 0.25, right: 0.25 } }
    expect(aspectRatio(scene, 1920, 1080)).toBeCloseTo(960 / 1080)
  })
})

describe("captions", () => {
  test("phrases split at sentence ends, with word timings", () => {
    const captions = captionsFromTranscript([{ start: 0, end: 6, text: "Hello there. This is the pricing page and it shows annual plans." }])
    expect(captions.length).toBe(2)
    expect(captions[0].text).toBe("Hello there.")
    expect(captions[1].words[0].start).toBeCloseTo(captions[0].end, 2)
    const [first, second] = splitCaption(captions[1], captions[1].words[3].start)!
    expect(first.words.length).toBe(3)
    expect(mergeCaptions(first, second).text).toBe(captions[1].text)
  })
  test("VTT follows the edit", () => {
    const project = deleteClip(splitAt(base(20), 5), 0)
    const vtt = captionsVtt([{ id: "a", start: 1, end: 2, text: "cut", words: [] }, { id: "b", start: 6, end: 8, text: "kept", words: [] }], (source) => toEdited(project, source))
    expect(vtt).toContain("00:00:01.000 --> 00:00:02.990")
    expect(vtt).not.toContain("cut")
  })
})

describe("layouts", () => {
  test("side by side: camera on the left third, the screen cropped to the rest", () => {
    const project = { ...newProject(10, null), layout: { preset: "side-by-side" as const, split: 1 / 3, screenX: 0.5, screenY: 0.5 } }
    const size = outputSize(project.scene, 2560, 1440, "1080", project.layout)
    expect(size).toEqual({ width: 1920, height: 1080 })
    const layout = layoutFor(project.scene, size.width, size.height, 2560, 1440, project.layout)
    expect(layout.camera).toEqual({ x: 0, y: 0, w: 640, h: 1080 })
    expect(layout.content).toEqual({ x: 640, y: 0, w: 1280, h: 1080 })
    // The screen keeps its height and loses its sides, centred.
    expect(layout.fill!.h).toBe(1440)
    expect(layout.fill!.w).toBeCloseTo(1440 * (1280 / 1080))
    expect(layout.fill!.x).toBeCloseTo((2560 - layout.fill!.w) / 2)
    const state = frameState(project, motionFor(project, []), 1, layout, 2560, 1440, 16 / 9, true)
    expect(state.webcam).toMatchObject({ x: 0, w: 640, radius: 0 })
    expect(state.view.w).toBeCloseTo(layout.fill!.w)
    // Showing the left edge of the screen instead.
    const left = layoutFor(project.scene, 1920, 1080, 2560, 1440, { ...project.layout, screenX: 0 })
    expect(left.fill!.x).toBe(0)
  })
  test("camera on the right, stacked, and camera only", () => {
    const base = newProject(10, null)
    const right = layoutFor(base.scene, 1920, 1080, 2560, 1440, { preset: "side-by-side-right", split: 1 / 3, screenX: 0.5, screenY: 0.5 })
    expect(right.camera!.x).toBe(1280)
    expect(outputSize(base.scene, 2560, 1440, "1080", { preset: "stacked", split: 1 / 3, screenX: 0.5, screenY: 0.5 })).toEqual({ width: 1080, height: 1920 })
    const project = { ...base, layout: { preset: "camera" as const, split: 1 / 3, screenX: 0.5, screenY: 0.5 } }
    const layout = layoutFor(project.scene, 1920, 1080, 2560, 1440, project.layout)
    const state = frameState(project, motionFor(project, []), 1, layout, 2560, 1440, 16 / 9, true)
    expect(state.webcam).toMatchObject({ x: 0, y: 0, w: 1920, h: 1080 })
    expect(state.cursor).toBeNull()
    expect(isUnedited(project, 10)).toBe(false)
  })
})

test("the webcam eases to its zoomed size, per zoom or by default", async () => {
  const { webcamScale } = await import("./render")
  const project = newProject(20, null)
  project.zooms = [
    { id: "a", start: 2, end: 4, depth: 2, mode: "manual", x: 0.5, y: 0.5, suggested: false },
    { id: "b", start: 10, end: 12, depth: 2, mode: "manual", x: 0.5, y: 0.5, suggested: false, webcamSize: 1.2 },
  ]
  expect(webcamScale(project, 1, 1)).toBe(1)
  expect(webcamScale(project, 3, 2)).toBeCloseTo(0.75)
  expect(webcamScale(project, 3, 1.5)).toBeCloseTo(0.875)
  expect(webcamScale(project, 11, 2)).toBeCloseTo(1.2)
  expect(webcamScale({ ...project, webcam: { ...project.webcam, reactsToZoom: false } }, 3, 2)).toBe(1)
})

test("the plain look: the recording as is, a rounded square webcam bottom left, the cursor, no zooms", async () => {
  const { plainProject } = await import("./model")
  const { webcamRect } = await import("./render")
  const project = plainProject(12, { x: 0.86, y: 0.8, size: 0.28 })
  expect(project.zooms).toEqual([])
  expect(project.scene.background.kind).toBe("none")
  expect(project.cursor.show).toBe(true)
  const rect = webcamRect(project.webcam, { width: 1920, height: 1080 } as never, 1, 16 / 9)!
  expect(rect.w).toBeCloseTo(rect.h)
  expect(rect.x).toBeCloseTo(32)
  expect(rect.y + rect.h).toBeCloseTo(1080 - 32)
  expect(rect.radius).toBeLessThan(rect.w * 0.2)
})
