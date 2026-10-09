import { useEffect, useMemo, useRef, useState } from "react"

import { cursorSprites, type CursorSprite, type SystemCursor } from "./cursors"
import type { Levels } from "./levels"
import type { EditProject } from "./model"

/** macOS's cursor pictures, loaded once, made into every style's sprites. */
export function useCursorSprites() {
  const [sprites, setSprites] = useState<Map<string, CursorSprite>>(() => cursorSprites())
  useEffect(() => {
    let cancelled = false
    void window.meetingRecorder.editorCursors().then(async (list) => {
      const system = new Map<string, SystemCursor>()
      await Promise.all(
        list.map(
          (entry) =>
            new Promise<void>((resolve) => {
              const image = new Image()
              image.onload = () => {
                system.set(entry.name, { ...entry, image })
                resolve()
              }
              image.onerror = () => resolve()
              image.src = entry.url
            }),
        ),
      )
      if (!cancelled) setSprites(cursorSprites(system))
    })
    return () => {
      cancelled = true
    }
  }, [])
  return sprites
}

/** An image element that's loaded (or null), for a url. */
function useImage(url: string | null) {
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  useEffect(() => {
    if (!url) {
      setImage(null)
      return
    }
    const element = new Image()
    element.onload = () => setImage(element)
    element.onerror = () => setImage(null)
    element.src = url
  }, [url])
  return image
}

/** The background's picture or looping video, for the scene's choice. */
export function useBackground(project: EditProject) {
  const { kind, value } = project.scene.background
  const image = useImage(kind === "image" || kind === "wallpaper" ? value : null)
  const video = useRef<HTMLVideoElement | null>(null)
  const [videoReady, setVideoReady] = useState(0)
  useEffect(() => {
    if (kind !== "video" || !value) {
      video.current?.pause()
      video.current = null
      setVideoReady(0)
      return
    }
    const element = document.createElement("video")
    element.src = value
    element.muted = true
    element.loop = true
    element.playsInline = true
    element.onloadeddata = () => setVideoReady((tick) => tick + 1)
    void element.play().catch(() => {})
    video.current = element
    return () => element.pause()
  }, [kind, value])
  return { backgroundImage: image, backgroundVideo: videoReady ? video.current : null }
}

/** Pictures used by notes, loaded by their data url or file url. */
export function useAnnotationImages(project: EditProject, onLoad: () => void) {
  const cache = useRef(new Map<string, HTMLImageElement>())
  const urls = useMemo(() => [...new Set(project.annotations.map((annotation) => annotation.image).filter(Boolean) as string[])], [project.annotations])
  useEffect(() => {
    for (const url of urls) {
      if (cache.current.has(url)) continue
      const image = new Image()
      image.onload = onLoad
      image.src = url
      cache.current.set(url, image)
    }
  }, [urls, onLoad])
  return cache.current
}

/** The recording's sound level every 10 ms (loudest sample and RMS), for the waveform and silence detection. */
export function useLevels(url: string | null) {
  const [levels, setLevels] = useState<Levels | null>(null)
  useEffect(() => {
    if (!url) return
    let cancelled = false
    void window.meetingRecorder.editorLevels(url).then((result) => !cancelled && setLevels(result?.rate ? (result as Levels) : null))
    return () => {
      cancelled = true
    }
  }, [url])
  return levels
}

/** A waveform, fetched once per file. */
export function usePeaks(url: string | null) {
  const [peaks, setPeaks] = useState<number[]>([])
  useEffect(() => {
    if (!url) return
    let cancelled = false
    void window.meetingRecorder.editorPeaks(url).then((result) => !cancelled && setPeaks(result))
    return () => {
      cancelled = true
    }
  }, [url])
  return peaks
}

/** Google Fonts you've added, registered so text notes can use them. */
export function useCustomFonts(onLoad: () => void) {
  const [fonts, setFonts] = useState<{ name: string; family: string; url: string }[]>([])
  const register = async (list: { name: string; family: string; url: string }[]) => {
    for (const font of list) {
      if ([...document.fonts].some((face) => face.family.replace(/"/g, "") === font.family)) continue
      try {
        const face = new FontFace(font.family, `url("${font.url}")`)
        await face.load()
        document.fonts.add(face)
      } catch {}
    }
    setFonts(list)
    onLoad()
  }
  useEffect(() => {
    void window.meetingRecorder.editorFonts().then(register)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return { fonts, add: async (link: string, name: string) => register(await window.meetingRecorder.editorAddFont(link, name)) }
}
