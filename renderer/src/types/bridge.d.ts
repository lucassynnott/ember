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
  startedAt?: number
  summary: string[]
  decisions: string[]
  actionItems: ActionItem[]
  provider?: string
  summaryProvider?: string
  transcriptionProvider?: string
}

export interface MeetingSaved {
  startedAt?: number
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

export interface DictionarySuggestion {
  term: string
  heardAs: string[]
  meeting: string
  calls: number
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
  calendarAccounts?: { provider: "googlecalendar" | "outlook"; accountId: string; email: string }[]
  calendarEnabled?: boolean
  prepEnabled?: boolean
  knowledgeFolders?: string[]
  knowledgeEnabled?: boolean
  captureSharedScreens?: boolean
  whatsNewSeen?: string
  liveNudges?: boolean
  aiProvider?: "openrouter" | "local"
  noteTemplate?: string
  localAiModelId?: string
  aiReady?: boolean
  aiLocal?: boolean
  liveNudgeFrequency?: "often" | "normal" | "rarely"
  dictationSnippets?: { trigger: string; text: string }[]
  dictationWhisper?: boolean
  dictationHistory?: boolean
  weeklyDigest?: boolean
  dictationStyleRules?: { app: string; style: string }[]
  dictationStylePresets?: Record<string, "casual" | "formal" | "plain" | "off">
  askHotkey?: Hotkey
  askHotkeyLabel?: string
  commandModeEnabled?: boolean
  commandHotkey?: Hotkey
  commandHotkeyLabel?: string
  liveHelpEnabled?: boolean
  liveHelpHotkey?: Hotkey
  liveHelpHotkeyLabel?: string
  grabTextEnabled?: boolean
  grabHotkey?: Hotkey
  grabHotkeyLabel?: string
  grabKeepLineBreaks?: boolean
  clipboardHistoryEnabled?: boolean
  clipboardHotkey?: Hotkey
  clipboardHotkeyLabel?: string
  clipboardKeepDays?: number
  clipboardIgnoreApps?: string[]
  savedEnabled?: boolean
  saveHotkey?: Hotkey
  saveHotkeyLabel?: string
  savedAi?: boolean
  recordEnabled?: boolean
  recordHotkeyLabel?: string
  recordCamera?: boolean
  recordCameraId?: string
  recordMode?: "screen" | "window" | "area" | "camera"
  recordCountdown?: boolean
  recordHideCursor?: boolean
  recordAutoFinish?: boolean
  driveBackupRecordings?: boolean
  driveBackupNotes?: boolean
  speakerSeparation?: boolean
  learnZoomVoices?: boolean
  launchAtLogin?: boolean
  loginItemStatus?: "not-registered" | "enabled" | "requires-approval" | "not-found"
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
  sections: { heading: string; items: string[] }[]
  template: string | null
  notePath: string | null
  audioPath: string | null
  transcription: string | null
  summaryModel: string | null
  summary: string[]
  decisions: string[]
  actionItems: (ActionItem & { done: boolean })[]
  yourNotes: { note: string; detail: string }[]
  slides: { time: string; caption: string; image: string | null }[]
  attendees: string[]
  transcript: { speaker: string | null; text: string }[]
}

export interface MeetingLibraryState {
  meetings: MeetingSummary[]
  folders: MeetingFolder[]
  tags: string[]
}

export type KnowledgeSources = Record<string, { file: string; name: string }>

export interface KnowledgeState {
  files?: number
  passages?: number
  indexedAt?: number | null
  errors?: { file: string; error: string }[]
  indexing?: boolean
  done?: number
  total?: number
  error?: string
  folders?: string[]
}

export interface KnowledgeSource {
  id: string
  name: string
  kind: "command" | "url"
  target: string
  tool: string
  queryArg: string
  tools: { name: string; description: string; args: string[] }[]
  enabled: boolean
  hasToken: boolean
  signedIn: boolean
  needsSignIn: boolean
  envKeys: string[]
  lastError: string | null
}

export interface PracticeResult {
  text: string
  seconds: number
  words: number
  wordsPerMinute: number | null
  fillers: number
  fillersPer100: number
  topFillers: { word: string; count: number }[]
  questions: number
}

export type IntegrationToolkit = "linear" | "notion" | "googledrive"
export type IntegrationKind = IntegrationToolkit | "reminders"
export type ActionDestination = "linear" | "notion" | "reminders"

export interface SentAction {
  destination: ActionDestination
  url: string | null
  at: number
}

export interface IntegrationState {
  mode: "hosted" | "personal"
  connected: Record<IntegrationToolkit | "googledocs", boolean>
  linearTeam: { id: string; name: string } | null
  notionDatabase: { id: string; name: string } | null
  remindersList: { id: string; name: string } | null
  driveFolder: { id: string; name: string } | null
  autoSend: "off" | "mine" | "all"
  autoSendTo: string
}

export interface AiModelState {
  selectedId: string
  runtime: boolean
  runtimeShared: boolean
  engine: "llama.cpp" | "mlx"
  models: { id: string; label: string; source: string; sizeLabel: string; detail: string; installed: boolean; progress: ModelProgress | null }[]
}

export interface ConnectState {
  cli: { installed: boolean; path: string; onPath: boolean }
  clients: { id: string; label: string; file: string; installed: boolean; connected: boolean }[]
  snippets: { claudeCode: string; json: string }
}

export interface ActionItemEntry {
  meetingId: string
  meetingTitle: string | null
  startedAt: number
  index: number
  owner: string
  task: string
  done: boolean
  mine: boolean
}

export interface CoachStats {
  timed: boolean
  yourWords: number
  totalWords: number
  talkShare: number
  fillers: number
  fillersPer100: number
  topFillers: { word: string; count: number }[]
  questions: number
  wordsPerMinute: number | null
  longestMonologueSeconds: number | null
  longestMonologueWords: number
  interruptions: number | null
}

export interface CoachWeek {
  calls: number
  talkShare: number
  fillersPer100: number
  wordsPerMinute: number | null
  questions: number
}

export interface DictationEntry {
  id: string
  at: number
  app: string
  kind: "dictation" | "edit"
  text: string
  words: number
  instruction?: string
}

export type ClipboardKind = "text" | "link" | "image" | "file" | "qr" | "barcode"

export interface ClipboardEntry {
  id: string
  at: number
  kind: ClipboardKind
  text: string
  app: string
  source?: "copy" | "screen"
  pinned?: boolean
  thumbnail?: string
  width?: number
  height?: number
}

export interface ClipboardList {
  entries: ClipboardEntry[]
  total: number
}

export type SavedKind = "post" | "article" | "video" | "link"

export interface SavedItem {
  id: string
  url: string
  status: "reading" | "tagging" | "ready" | "failed"
  error?: string
  kind: SavedKind
  title: string
  description: string
  siteName: string
  author: string
  summary: string
  tags: string[]
  boards: string[]
  savedAt: number
  publishedAt?: number | null
  excerpt: string
  thumbnail: string
}

export interface SavedBoard {
  id: string
  name: string
  count: number
}

export interface FinishingCall {
  startedAt: number
  title: string | null
  message: string
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

export interface DashboardStats {
  weekId: string
  meetings: number
  lastWeekMeetings: number
  minutes: number
  byDay: number[]
  today: number
  words: number
  yourWords: number
  people: { name: string; calls: number }[]
  actions: { task: string; meetingId: string; meetingTitle: string | null; startedAt: number; index: number }[]
  dictation: { weekWords: number; weekSessions: number; totalWords: number; today: number; minutesSaved: number }
  dictationEnabled: boolean
}

export interface TodayEvent {
  title: string
  start: number
  end: number
  link: string | null
  attendees: string[]
  calendar: string
}

export interface AskTurn {
  role: "user" | "assistant"
  content: string
}

export type AskScope = { kind: "all" } | { kind: "unfiled" } | { kind: "folder"; id: string } | { kind: "meeting"; id: string }

export type RecordingStatus = "pending" | "processing" | "ready" | "failed"

export interface RecordingSummary {
  id: string
  title: string
  summary: string
  createdAt: string
  duration: number
  width: number
  height: number
  status: RecordingStatus
  error: string | null
  chapterCount: number
  hasThumb: boolean
  /** auto: made by Ember straight after recording, in your default style. */
  edited: { duration: number; width: number; height: number; exportedAt: string; auto?: boolean | string } | null
  /** The plain version: the recording with its webcam and cursor added, as the recording page shows and shares it. */
  finished?: { duration: number; width: number; height: number; exportedAt: string } | null
  /** Ember is making the plain version. */
  finishing?: boolean
  share: RecordingShare | null
  /** The separately recorded webcam's bubble: centre and size, as parts of the frame. */
  camera?: { x: number; y: number; size: number } | null
  folder: string | null
  editedAt: string
}

export interface RecordingFolder {
  id: string
  name: string
  color: string
}

export interface RecordingShare {
  id: string
  url: string
  sharedAt: string
  expiresAt: string | null
  hasPassword: boolean
  download: boolean
  transcript: boolean
  edited: boolean
  outdated: boolean
}

export interface ShareState {
  connected: boolean
  mode: "hosted" | "personal"
  ready: boolean
  url: string | null
  accountName: string | null
  setting: boolean
}

export interface ShareOptions {
  expiresDays?: number
  password?: string
  download?: boolean
  transcript?: boolean
  /** Which version to upload: the plain one the recording page shows (default), or the editor's. */
  version?: "plain" | "edited"
}

export type ShareReply = { ok: true; url?: string } | { ok?: false; error: string; code: string | number | null; url: string | null }

export interface RecordingEditData {
  id: string
  title: string
  share?: RecordingShare | null
  duration: number
  width: number
  height: number
  project: unknown
  pointer: number[][] | null
  cursorHidden: boolean
  hasCamera: boolean
  hasSystem: boolean
  cameraLayout: { x: number; y: number; size: number } | null
  defaults: Record<string, unknown> | null
  autoZooms: boolean
  transcript: { start: number; end: number; text: string }[]
}

export interface EditorAsset {
  name: string
  url: string
  kind: "image" | "video" | "audio"
}

export interface EditorPreset {
  id: string
  name: string
  style: Record<string, unknown>
  savedAt: string
}

export interface RecordingDetail extends RecordingSummary {
  chapters: { start: number; title: string }[]
  transcript: { start: number; end: number; text: string }[]
  source: string
}

/** Ember Drive: cloud storage as a drive in Finder. */
export type DriveProvider = "b2" | "r2" | "s3" | "wasabi" | "custom"

export interface DriveStatus {
  accountID?: string | null
  accounts?: { id: string; provider: DriveProvider; bucket: string; path: string; selected: boolean }[]
  supported: boolean
  configured?: boolean
  provider?: DriveProvider | null
  bucket?: string | null
  mounted?: boolean
  path?: string
  sidebarReady?: boolean
  backupScan?: { running: boolean; copied: number; failed: number; cancelled?: boolean; finished?: number }
  pendingUploads?: number
  message?: string | null
  /** macOS has Ember Drive turned off as a file system. */
  needsEnable?: boolean
  notice?: { message: string; actionTitle?: string | null; actionURL?: string | null } | null
  pins?: { keys: string[]; syncing: boolean; done: number; total: number }
  cacheLimitGB?: number
  /** Ghost's settings are there to bring across. */
  legacyGhost?: boolean
  ghostInstalled?: boolean
}

export interface DriveConfig {
  provider: DriveProvider
  keyID: string
  /** Blank keeps the saved secret. */
  applicationKey: string
  bucketName: string
  accountID: string
  region: string
  endpoint: string
}

export interface DriveCheck {
  id: number
  title: string
  state: "pending" | "running" | "passed" | "warning" | "failed"
  detail: string
}

export interface DriveHit {
  key: string
  name: string
  folder: string
  size: number
}

export interface MeetingRecorderBridge {
  recordingsList(query?: string): Promise<RecordingSummary[]>
  recordingGet(id: string): Promise<RecordingDetail | null>
  newScreenRecording(): Promise<void>
  importRecording(): Promise<string | null>
  openRecordingsFolder(): Promise<void>
  recordingFolders(): Promise<RecordingFolder[]>
  createRecordingFolder(name: string, color?: string): Promise<RecordingFolder>
  updateRecordingFolder(id: string, changes: { name?: string; color?: string }): Promise<RecordingFolder>
  deleteRecordingFolder(id: string): Promise<boolean>
  setRecordingFolder(ids: string[], folder: string | null): Promise<boolean>
  renameRecording(id: string, title: string): Promise<boolean>
  removeRecording(id: string): Promise<boolean>
  retryRecording(id: string): Promise<boolean>
  revealRecording(id: string): Promise<void>
  copyRecordingFile(id: string): Promise<boolean>
  exportRecording(id: string): Promise<string | null>
  loadRecordingEdit(id: string): Promise<RecordingEditData | null>
  saveRecordingEdit(id: string, project: unknown): Promise<boolean>
  exportRecordingEdit(id: string, spec: unknown, extra?: { backgroundVideo?: string | null; captions?: string | null; cameraFile?: string | null; share?: boolean; auto?: boolean }): Promise<boolean>
  editorCursors(): Promise<{ name: string; width: number; height: number; hotX: number; hotY: number; url: string }[]>
  editorWallpapers(): Promise<{ id: string; label: string; url: string; thumb: string }[]>
  editorPick(kind: "image" | "video" | "audio"): Promise<EditorAsset | null>
  editorPresets(): Promise<EditorPreset[]>
  editorFonts(): Promise<{ name: string; family: string; url: string }[]>
  editorAddFont(link: string, name: string): Promise<{ name: string; family: string; url: string }[]>
  editorPeaks(url: string): Promise<number[]>
  editorSavePreset(name: string, style: unknown): Promise<EditorPreset[]>
  editorDeletePreset(id: string): Promise<EditorPreset[]>
  editorSaveDefaults(style: unknown): Promise<boolean>
  editorSetAutoZooms(on: boolean): Promise<boolean>
  cancelRecordingExport(id: string): Promise<boolean>
  discardRecordingEdit(id: string): Promise<boolean>
  showExportedFile(file: string): Promise<void>
  shareState(): Promise<ShareState>
  shareConnect(): Promise<ShareReply & Partial<ShareState>>
  shareCancel(): Promise<void>
  shareSetup(): Promise<ShareReply & Partial<ShareState>>
  shareDisconnect(): Promise<ShareState>
  shareOpenCloudflare(url?: string): Promise<void>
  onShareProgress(handler: (progress: { state: "working" | "waiting" | "done" | "failed"; step?: string; message: string; url?: string | null }) => void): () => void
  shareRecording(id: string, options: ShareOptions): Promise<ShareReply>
  cancelRecordingShare(id: string): Promise<void>
  updateRecordingShare(id: string, options: ShareOptions): Promise<ShareReply>
  unshareRecording(id: string): Promise<ShareReply>
  openRecordingShare(id: string): Promise<void>
  onRecordingShare(handler: (progress: { id: string; url: string; state: "uploading" | "done" | "failed"; value: number; error?: string }) => void): () => void
  onRecordingExport(handler: (progress: { id: string; state: "running" | "done" | "failed" | "cancelled"; value: number; error?: string; path?: string }) => void): () => void
  onRecordingsChanged(handler: () => void): () => void
  onOpenRecording(handler: (id: string, edit: boolean, share: boolean) => void): void
  driveStatus(): Promise<DriveStatus>
  driveRequest<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>
  driveSetupCloudflare(options?: { accountID?: string; dryRun?: boolean }): Promise<{ bucket: string; account: string; accountID?: string; tested?: boolean }>
  driveCloudflareAccounts(): Promise<Array<{ id: string; name: string }>>
  driveBackupNow(): Promise<number>
  driveCopyLink(key: string): Promise<string>
  driveShareVideo(key: string): Promise<void>
  driveHideSearch(): Promise<void>
  driveOpenSearch(): Promise<void>
  driveOpenExtensionSettings(): Promise<void>
  driveRemoveGhost(): Promise<boolean>
  driveOpenGuide(url: string): Promise<void>
  onDriveStatus(handler: (status: DriveStatus) => void): () => void
  onDriveTest(handler: (data: { checks: DriveCheck[] }) => void): () => void
  onDriveSetupProgress(handler: (message: string) => void): () => void
  onDriveSearchOpen(handler: () => void): () => void
  listMeetings(): Promise<MeetingLibraryState>
  searchMeetings(query: string): Promise<string[] | null>
  getMeeting(id: string): Promise<MeetingDetail>
  actionItems(): Promise<ActionItemEntry[]>
  setActionDone(meetingId: string, index: number, done: boolean): Promise<boolean>
  coachStats(id: string): Promise<CoachStats | null>
  coachWeek(): Promise<CoachWeek | null>
  updateMeeting(id: string, changes: { title?: string; folderId?: string | null; tags?: string[] }): Promise<unknown>
  removeMeeting(id: string): Promise<boolean>
  createFolder(name: string): Promise<MeetingFolder>
  renameFolder(id: string, name: string): Promise<MeetingFolder>
  deleteFolder(id: string): Promise<boolean>
  openMeetingNote(id: string): Promise<string>
  revealMeeting(id: string, kind: "note" | "audio"): Promise<boolean>
  onLibraryChanged(handler: () => void): void
  onOpenMeeting(handler: (id: string) => void): void
  onNavigate(handler: (page: string) => void): void
  setUserNotes(text: string): Promise<boolean>
  installedApps(): Promise<string[]>
  dictationHistory(query: string): Promise<{ entries: DictationEntry[]; total: number }>
  clipboardList(query: string, kind: string): Promise<ClipboardList>
  clipboardPin(id: string, pinned: boolean): Promise<boolean>
  clipboardRemove(id: string): Promise<boolean>
  clipboardClear(includePinned: boolean): Promise<boolean>
  clipboardCopy(id: string): Promise<boolean>
  grabText(fromClipboard?: boolean): Promise<boolean>
  onClipboardChanged(handler: () => void): () => void
  onOpenPage(handler: (page: string) => void): void
  savedList(filter: { query?: string; board?: string; tag?: string; kind?: string }): Promise<{ items: SavedItem[]; total: number }>
  savedBoards(): Promise<SavedBoard[]>
  savedTags(): Promise<{ tag: string; count: number }[]>
  saveLink(input: string, board?: string | null): Promise<{ id: string; existing: boolean }>
  savedRetry(id: string): Promise<boolean>
  savedRemove(id: string): Promise<boolean>
  savedSetBoard(id: string, board: string, included: boolean): Promise<boolean>
  savedSetTags(id: string, tags: string[]): Promise<boolean>
  createBoard(name: string): Promise<{ id: string; name: string }>
  renameBoard(id: string, name: string): Promise<boolean>
  removeBoard(id: string): Promise<boolean>
  openSaved(id: string): Promise<boolean>
  openLoginItems(): Promise<boolean>
  onSavedChanged(handler: () => void): () => void
  copyDictation(id: string): Promise<boolean>
  removeDictation(id: string): Promise<boolean>
  clearDictationHistory(): Promise<boolean>
  onHistoryChanged(handler: () => void): void
  liveHelp(requestId: string, request: { question: string; history: AskTurn[] }): Promise<{ text: string; sources?: KnowledgeSources; cancelled?: boolean }>
  knowledgeState(): Promise<KnowledgeState>
  addKnowledgeFolder(): Promise<string[]>
  removeKnowledgeFolder(folder: string): Promise<string[]>
  reindexKnowledge(): Promise<KnowledgeState | null>
  knowledgeSources(): Promise<KnowledgeSource[]>
  addKnowledgeSource(source: { name: string; kind: "command" | "url"; command?: string; url?: string; token?: string; env?: string }): Promise<KnowledgeSource[]>
  updateKnowledgeSource(id: string, changes: { enabled?: boolean; tool?: string; queryArg?: string }): Promise<KnowledgeSource[]>
  removeKnowledgeSource(id: string): Promise<KnowledgeSource[]>
  signInKnowledgeSource(id: string): Promise<KnowledgeSource[]>
  testKnowledgeSources(query: string): Promise<{ file: string; name: string; text: string }[]>
  startPractice(): Promise<boolean>
  stopPractice(): Promise<PracticeResult | null>
  cancelPractice(): Promise<boolean>
  integrations(): Promise<IntegrationState>
  setIntegrationMode(mode: "hosted" | "personal"): Promise<IntegrationState>
  connectIntegration(toolkit: IntegrationToolkit): Promise<IntegrationState>
  cancelIntegration(): Promise<void>
  disconnectIntegration(toolkit: IntegrationToolkit): Promise<IntegrationState>
  integrationOptions(kind: IntegrationKind, query?: string): Promise<{ id: string; name: string }[]>
  chooseIntegration(kind: IntegrationKind, choice: { id: string; name: string } | null): Promise<IntegrationState>
  setAutoSend(options: { autoSend: "off" | "mine" | "all"; autoSendTo: string }): Promise<IntegrationState>
  sentActions(): Promise<Record<string, SentAction>>
  openSentLink(url: string): Promise<void>
  sendAction(meetingId: string, index: number, destination: ActionDestination): Promise<SentAction>
  onIntegrationProgress(handler: (progress: { toolkit: string; state: string; message?: string }) => void): void
  onIntegrationsChanged(handler: () => void): void
  aiModels(): Promise<AiModelState>
  installAiModel(id: string): Promise<AiModelState>
  cancelAiModel(id: string): Promise<AiModelState>
  removeAiModel(id: string): Promise<AiModelState>
  onAiModelProgress(handler: (progress: ModelProgress) => void): void
  onAiModelsChanged(handler: (state: AiModelState) => void): void
  noteTemplates(): Promise<{ id: string; label: string; sections: string[] }[]>
  setMeetingTemplate(id: string): Promise<string | null>
  connectState(): Promise<ConnectState>
  installCli(): Promise<ConnectState>
  connectClient(id: string, connect: boolean): Promise<ConnectState>
  copyText(text: string): Promise<boolean>
  openKnowledgeFile(file: string): Promise<void>
  onKnowledgeState(handler: (state: KnowledgeState) => void): void
  dashboard(): Promise<DashboardStats>
  calendarToday(): Promise<{ enabled: boolean; events: TodayEvent[] }>
  openCalendarLink(link: string): Promise<void>
  onDashboardChanged(handler: () => void): void
  listDigests(): Promise<{ id: string; label: string; writtenAt: number | null }[]>
  getDigest(id: string): Promise<{ id: string; label: string; start: number; end: number; markdown: string } | null>
  writeDigest(requestId: string, id: string): Promise<{ id: string; label: string; markdown: string }>
  onDigestsChanged(handler: () => void): void
  calendarStatus(): Promise<string>
  connectWindowsTasks(): Promise<string>
  connectCalendar(provider?: "googlecalendar" | "outlook"): Promise<string>
  openCalendarPrivacy(): Promise<void>
  onCalendar(handler: (event: { title: string; attendees: string[]; startedAt?: number }) => void): void
  renameSpeaker(id: string, from: string, to: string): Promise<{ learned: boolean }>
  speakerNames(): Promise<string[]>
  dictionarySuggestions(): Promise<DictionarySuggestion[]>
  answerDictionarySuggestion(term: string, accepted: boolean): Promise<boolean>
  onDictionarySuggestions(handler: () => void): () => void
  voicesState(): Promise<VoicesState>
  retryVoiceModel(): Promise<boolean>
  forgetVoice(id: string): Promise<KnownVoice[]>
  onVoicesState(handler: (state: VoicesState) => void): void
  onRelabel(handler: (event: { startedAt: number; labels: Record<string, string> }) => void): void
  onVoiceNote(handler: (note: { startedAt: number; line: string }) => void): void
  onJobs(handler: (jobs: FinishingCall[]) => void): void
  onSlides(handler: (slides: { startedAt: number; count: number; latest: string }) => void): void
  askMeetings(
    requestId: string,
    request: { question: string; history: AskTurn[]; scope: AskScope },
  ): Promise<{ text: string; meetingCount?: number; cancelled?: boolean; sources?: KnowledgeSources }>
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
  startAppRecording(options?: { inPerson?: boolean }): Promise<boolean>
  stopAppRecording(): Promise<boolean>
  hideControls(): Promise<void>
  requestPermissions(): Promise<PermissionState>
  openSettings(section?: string): Promise<void>
  onSettingsSection(handler: (section: string) => void): void
  onSettingsChanged(handler: (state: Partial<SettingsState>) => void): void
  openNotesFolder(): Promise<void>
  openNote(path: string): Promise<void>
  getSettings(): Promise<SettingsState>
  onboardingPermissions(): Promise<OnboardingPermissions>
  requestPermission(kind: keyof OnboardingPermissions): Promise<OnboardingPermissions>
  suggestedName(): Promise<string>
  finishOnboarding(): Promise<boolean>
  readonly platform: string
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
  join(): void
  openSource(id: string): void
  resize(height: number): void
  action(name: "nudge:more" | "nudge:off" | "nudge:fewer" | "nudge:settings" | "prep:off" | "prep:settings"): void
}

export interface ClipboardPickerBridge {
  readonly platform: string
  onOpen(handler: (state: { app: string }) => void): void
  onChanged(handler: () => void): () => void
  list(query: string, kind: string): Promise<ClipboardList>
  pin(id: string, pinned: boolean): Promise<boolean>
  remove(id: string): Promise<boolean>
  choose(id: string, how: "paste" | "copy"): void
  openPage(): void
  close(): void
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
    clipboardPicker: ClipboardPickerBridge
  }
}
