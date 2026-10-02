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
  call?: { app: string; via?: string; active: boolean; browser: boolean } | null
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
  accountId?: string
}

export type NotionAuth = "cli" | "composio"

export interface NotionProgress {
  state: "downloading" | "installing" | "starting-login" | "waiting" | "connected" | "failed" | "cancelled"
  message?: string
  received?: number
  total?: number
  fraction?: number
  url?: string
  code?: string
  step?: "composio" | "notion"
}

export interface NotionStatus {
  method: NotionAuth
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

export interface UpdateState {
  state: "idle" | "checking" | "up-to-date" | "downloading" | "ready" | "error"
  supported: boolean
  currentVersion: string
  version?: string
  percent?: number
  error?: string | null
  checkedAt?: number
}

export interface DictationStatus {
  enabled: boolean
  running: boolean
  accessibility: boolean | null
  tap: boolean | null
  hotkeyLabel: string
}

export interface OnboardingPermissions {
  microphone: PermissionStatus
  screen: PermissionStatus
  accessibility: PermissionStatus
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
  notionAuth: NotionAuth
  onboardingCompleted: boolean
  dictationEnabled: boolean
  dictationHotkey: Hotkey
  dictationHotkeyLabel: string
  dictationMode: "hold" | "toggle"
  dictationKeepOnClipboard: boolean
  dictationCleanup: "off" | "light" | "ai"
  voiceAskEnabled?: boolean
  dictionary?: { term: string; heardAs: string[] }[]
  calendarEnabled?: boolean
  prepEnabled?: boolean
  dictationStyleRules?: { app: string; style: string }[]
  dictationStylePresets?: Record<string, "casual" | "formal" | "plain" | "off">
  askHotkey?: Hotkey
  askHotkeyLabel?: string
  commandModeEnabled?: boolean
  commandHotkey?: Hotkey
  commandHotkeyLabel?: string
  speakerSeparation?: boolean
  learnZoomVoices?: boolean
  launchAtLogin?: boolean
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

export interface MeetingFolder {
  id: string
  name: string
}

export interface MeetingSummary {
  id: string
  title: string | null
  startedAt: number | null
  duration: number | null
  preview: string | null
  folderId: string | null
  tags: string[]
  hasNote: boolean
  hasAudio: boolean
  notionUrl: string | null
  actionItemCount: number
}

export interface MeetingDetail extends MeetingSummary {
  notePath: string | null
  audioPath: string | null
  transcription: string | null
  summaryModel: string | null
  summary: string[]
  decisions: string[]
  actionItems: (ActionItem & { done: boolean })[]
  yourNotes: { note: string; detail: string }[]
  attendees: string[]
  transcript: { speaker: string | null; text: string }[]
}

export interface MeetingLibraryState {
  meetings: MeetingSummary[]
  folders: MeetingFolder[]
  tags: string[]
}

export interface KnownVoice {
  id: string
  name: string
  seconds: number
  updatedAt: string
}

export interface VoicesState {
  state: "missing" | "downloading" | "ready" | "failed"
  received?: number
  total?: number
  error?: string
  voices?: KnownVoice[]
}

export interface AskTurn {
  role: "user" | "assistant"
  content: string
}

export type AskScope = { kind: "all" } | { kind: "unfiled" } | { kind: "folder"; id: string } | { kind: "meeting"; id: string }

export interface MeetingRecorderBridge {
  listMeetings(): Promise<MeetingLibraryState>
  searchMeetings(query: string): Promise<string[] | null>
  getMeeting(id: string): Promise<MeetingDetail>
  updateMeeting(id: string, changes: { title?: string; folderId?: string | null; tags?: string[] }): Promise<unknown>
  removeMeeting(id: string): Promise<boolean>
  createFolder(name: string): Promise<MeetingFolder>
  renameFolder(id: string, name: string): Promise<MeetingFolder>
  deleteFolder(id: string): Promise<boolean>
  openMeetingNote(id: string): Promise<string>
  revealMeeting(id: string, kind: "note" | "audio"): Promise<boolean>
  onLibraryChanged(handler: () => void): void
  onOpenMeeting(handler: (id: string) => void): void
  setUserNotes(text: string): Promise<boolean>
  installedApps(): Promise<string[]>
  calendarStatus(): Promise<string>
  connectCalendar(): Promise<string>
  openCalendarPrivacy(): Promise<void>
  onCalendar(handler: (event: { title: string; attendees: string[] }) => void): void
  renameSpeaker(id: string, from: string, to: string): Promise<{ learned: boolean }>
  speakerNames(): Promise<string[]>
  voicesState(): Promise<VoicesState>
  retryVoiceModel(): Promise<boolean>
  forgetVoice(id: string): Promise<KnownVoice[]>
  onVoicesState(handler: (state: VoicesState) => void): void
  onRelabel(handler: (labels: Record<string, string>) => void): void
  askMeetings(
    requestId: string,
    request: { question: string; history: AskTurn[]; scope: AskScope },
  ): Promise<{ text: string; meetingCount?: number; cancelled?: boolean }>
  cancelAsk(requestId: string): Promise<boolean>
  draftFollowUp(requestId: string, id: string, kind: "email" | "slack"): Promise<{ text: string; cancelled?: boolean }>
  onAskDelta(handler: (delta: { requestId: string; delta: string }) => void): void
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
  onboardingPermissions(): Promise<OnboardingPermissions>
  requestPermission(kind: keyof OnboardingPermissions): Promise<OnboardingPermissions>
  suggestedName(): Promise<string>
  finishOnboarding(): Promise<boolean>
  saveSettings(update: Partial<SettingsState> & Record<string, unknown>): Promise<SettingsState>
  chooseNotesFolder(): Promise<string | null>
  getOpenRouterModels(): Promise<OpenRouterModel[]>
  listModels(): Promise<ModelListState>
  notionStatus(): Promise<NotionStatus>
  notionConnect(method?: NotionAuth): Promise<{ account: NotionAccount | null; status: NotionStatus }>
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
  updateStatus(): Promise<UpdateState>
  checkForUpdates(): Promise<UpdateState>
  installUpdate(): Promise<boolean>
  onUpdateState(handler: (state: UpdateState) => void): void
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

export interface AskCardBridge {
  onState(handler: (state: unknown) => void): void
  close(): void
  openMeeting(id: string): void
  resize(height: number): void
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
    askCard: AskCardBridge
  }
}
