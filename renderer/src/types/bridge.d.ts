export type Phase = "idle" | "starting" | "recording" | "stopping" | "processing"

export type PermissionStatus =
  | "granted"
  | "denied"
  | "restricted"
  | "not-determined"
  | "not-granted"
  | "system-audio-unavailable"
  | "unknown"

export interface PermissionState {
  microphone: PermissionStatus
  screen: PermissionStatus
  accessibility: PermissionStatus
}

export interface ZoomState {
  accessibility?: boolean | string
  meetingOpen?: boolean
  screenSharing?: boolean
  participants?: string[]
  activeSpeakers?: string[]
}

export interface ZoomAutoRecordingState {
  enabled?: boolean
  suppressed?: boolean
  pending?: "start" | "stop" | null
  recordingOrigin?: string | null
}

export interface TranscriptSegment {
  text: string
  timestamp?: string
  speaker?: string
  source?: "microphone" | "system"
}

export interface ActionItem {
  owner?: string
  task: string
}

export interface Analysis {
  summary: string[]
  decisions: string[]
  actionItems: ActionItem[]
  provider?: string
  summaryProvider?: string
  transcriptionProvider?: string
}

export interface MeetingSaved {
  notePath: string | null
  notion?: boolean
  notionUrl?: string | null
}

export type NotesDestination = "folder" | "notion" | "both"

export interface NotionAccount {
  email: string
  workspace: string
  name: string
}

export interface NotionProgress {
  state: "downloading" | "installing" | "starting-login" | "waiting" | "connected" | "failed" | "cancelled"
  message?: string
  received?: number
  total?: number
  fraction?: number
  url?: string
  code?: string
}

export interface NotionStatus {
  installed: boolean
  account: NotionAccount | null
  unavailable?: boolean
  database: { id: string; name: string | null; url?: string | null; error?: string } | null
  busy: boolean
  progress: NotionProgress | null
}

export interface NotionSearchResult {
  pages: { id: string; title: string; url?: string }[]
  databases: { id: string; title: string }[]
}

export interface Hotkey {
  keyCode: number | null
  modifiers: string[]
  keyName?: string
}

export interface TranscriptionModel {
  id: string
  type: "phonon" | "parakeet" | "whisper"
  catalogId?: string
  label: string
  detail?: string
  path: string
  realtime: boolean
}

export interface ModelProgress {
  id: string
  state: "starting" | "downloading" | "installing" | "finishing" | "installed" | "failed" | "cancelled"
  message?: string
  fraction?: number
  received?: number
  total?: number
}

export interface CatalogModel {
  id: string
  label: string
  source: string
  languages: string
  realtime: boolean
  sizeLabel: string
  detail: string
  installedModelId: string | null
  progress: ModelProgress | null
}

export interface ModelListState {
  selectedId: string
  installed: TranscriptionModel[]
  catalog: CatalogModel[]
}

export interface DictationStatus {
  enabled: boolean
  running: boolean
  accessibility: boolean | null
  tap: boolean | null
  hotkeyLabel: string
}

export interface SettingsState {
  notesDir: string
  speakerName: string
  autoRecordZoomMeetings: boolean
  transcriptionModelId: string
  openRouterModel: string
  hasOpenRouterKey: boolean
  notionSyncEnabled: boolean
  notesDestination: NotesDestination
  notionDataSourceId: string
  notionDatabaseName: string
  dictationEnabled: boolean
  dictationHotkey: Hotkey
  dictationHotkeyLabel: string
  dictationMode: "hold" | "toggle"
  dictationKeepOnClipboard: boolean
  microphoneLabel?: string
  mappedSystemOutputLabel?: string
  transcriptionModels: TranscriptionModel[]
}

export interface OpenRouterModel {
  id: string
  name: string
  provider?: string
}

export interface RecorderCommand {
  id: string
  action: "start" | "stop" | "request-screen-permission"
  payload: { microphoneLabel?: string; mappedSystemOutputLabel?: string }
}

export interface MeetingRecorderBridge {
  appendChunk(chunk: ArrayBuffer): Promise<boolean>
  appendLivePcm(chunk: {
    source: "microphone" | "system"
    samples: ArrayBuffer
    startedAt: number | null
    endedAt: number
  }): Promise<boolean>
  startAppRecording(): Promise<boolean>
  stopAppRecording(): Promise<boolean>
  hideControls(): Promise<void>
  requestPermissions(): Promise<PermissionState>
  openSettings(): Promise<void>
  openNotesFolder(): Promise<void>
  openNote(path: string): Promise<void>
  getSettings(): Promise<SettingsState>
  saveSettings(update: Partial<SettingsState> & Record<string, unknown>): Promise<SettingsState>
  chooseNotesFolder(): Promise<string | null>
  getOpenRouterModels(): Promise<OpenRouterModel[]>
  listModels(): Promise<ModelListState>
  notionStatus(): Promise<NotionStatus>
  notionConnect(): Promise<{ account: NotionAccount | null; status: NotionStatus }>
  notionCancel(): Promise<boolean>
  notionSearch(query: string): Promise<NotionSearchResult>
  notionUseDatabase(database: { id: string; name: string }): Promise<SettingsState>
  notionCreateDatabase(parentPageId: string): Promise<{ database: { id: string; name: string; url?: string }; state: SettingsState }>
  notionDisconnect(): Promise<SettingsState>
  onNotionProgress(handler: (progress: NotionProgress) => void): void
  installModel(id: string): Promise<boolean>
  cancelModelInstall(id: string): Promise<boolean>
  removeModel(id: string): Promise<ModelListState>
  selectModel(id: string): Promise<ModelListState>
  getDictationStatus(): Promise<DictationStatus>
  captureHotkey(): Promise<{ hotkey: Hotkey; label: string } | null>
  cancelHotkeyCapture(): Promise<void>
  onDictationStatus(handler: (status: DictationStatus) => void): void
  onModelProgress(handler: (progress: ModelProgress) => void): void
  onModelsChanged(handler: (state: ModelListState) => void): void
  onPermissionState(handler: (state: PermissionState) => void): void
  onZoomState(handler: (state: ZoomState) => void): void
  onZoomAutoRecordingState(handler: (state: ZoomAutoRecordingState) => void): void
  onState(handler: (state: { phase: Phase; message: string }) => void): void
  onMeetingReset(handler: (startedAt?: number) => void): void
  onTranscript(handler: (segment: TranscriptSegment) => void): void
  onAnalysis(handler: (analysis: Analysis) => void): void
  onMeetingSaved(handler: (saved: MeetingSaved) => void): void
  completeCommand(id: string, result: unknown): void
  failCommand(id: string, error: unknown): void
  onCommand(handler: (command: RecorderCommand) => void): void
}

export interface DictationBridge {
  onState(handler: (state: { state: string; message?: string }) => void): void
  onCaptureStart(handler: (request: { id: number; microphoneLabel: string }) => void): void
  onCaptureStop(handler: (request: { id: number; tailMs: number }) => void): void
  onCaptureCancel(handler: () => void): void
  captureStarted(id: number, error: string | null): void
  captureStopped(id: number, samples: ArrayBuffer | null, error: string | null): void
}

declare global {
  interface Window {
    meetingRecorder: MeetingRecorderBridge
    dictation: DictationBridge
  }
}
