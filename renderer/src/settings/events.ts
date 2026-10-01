import { useEffect, useRef } from "react"

import type { DictationStatus, ModelListState, ModelProgress, NotionProgress, UpdateState } from "@/types/bridge"

interface Handlers {
  modelProgress?: (progress: ModelProgress) => void
  modelsChanged?: (state: ModelListState) => void
  dictationStatus?: (status: DictationStatus) => void
  notionProgress?: (progress: NotionProgress) => void
  updateState?: (state: UpdateState) => void
}

const subscribers = new Set<React.RefObject<Handlers>>()
let connected = false

// The preload exposes add-only listeners, so subscribe once and fan out to mounted sections.
function connect() {
  if (connected) return
  connected = true
  window.meetingRecorder.onModelProgress((progress) => {
    for (const ref of subscribers) ref.current?.modelProgress?.(progress)
  })
  window.meetingRecorder.onModelsChanged((state) => {
    for (const ref of subscribers) ref.current?.modelsChanged?.(state)
  })
  window.meetingRecorder.onDictationStatus((status) => {
    for (const ref of subscribers) ref.current?.dictationStatus?.(status)
  })
  window.meetingRecorder.onNotionProgress((progress) => {
    for (const ref of subscribers) ref.current?.notionProgress?.(progress)
  })
  window.meetingRecorder.onUpdateState((state) => {
    for (const ref of subscribers) ref.current?.updateState?.(state)
  })
}

export function useBridgeEvents(handlers: Handlers) {
  const ref = useRef(handlers)
  ref.current = handlers
  useEffect(() => {
    connect()
    subscribers.add(ref)
    return () => {
      subscribers.delete(ref)
    }
  }, [])
}
