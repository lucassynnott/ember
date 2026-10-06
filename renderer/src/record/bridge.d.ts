export interface RecordDisplay {
  id: number
  label: string
  width: number
  height: number
  primary: boolean
  current: boolean
}

export interface RecordWindow {
  id: number
  app: string
  title: string
  frame: [number, number, number, number]
}

export interface RecordSources {
  displays: RecordDisplay[]
  windows: RecordWindow[]
  prefs: { mode: RecordMode; camera: boolean; cameraId: string; microphone: string; countdown: number; systemAudio: boolean; shortcut: string }
}

export type RecordMode = "screen" | "window" | "area" | "camera"

export interface RecordStatus {
  state: string
  paused: boolean
  elapsed: number
  running: boolean
  cameraSize?: CameraSize
  cameraId?: string
  camera?: boolean | null
}

export type CameraSize = "small" | "medium" | "large"

export interface RecordBridge {
  sources(): Promise<RecordSources | null>
  status(): Promise<RecordStatus>
  start(options: { mode: RecordMode; displayId?: number; windowId?: number; microphone: string; cameraName?: string; systemAudio?: boolean; countdown?: number }): Promise<void>
  camera(options: { on: boolean; deviceId?: string }): Promise<void>
  cameraSize(size: CameraSize): void
  area(rect: { x: number; y: number; width: number; height: number } | null): void
  control(command: "pause" | "resume" | "stop" | "restart" | "cancel" | "hide-controls" | "toggle-camera"): void
  skipCount(): void
  close(): void
  highlight(windowId: number): void
  onState(handler: (status: RecordStatus) => void): () => void
  onLevel(handler: (level: number) => void): () => void
  onCount(handler: (count: number) => void): () => void
  onCamera(handler: (camera: { deviceId: string; size: CameraSize }) => void): () => void
  onStartNow(handler: () => void): () => void
  onError(handler: (message: string) => void): () => void
}

declare global {
  interface Window {
    record: RecordBridge
  }
}
