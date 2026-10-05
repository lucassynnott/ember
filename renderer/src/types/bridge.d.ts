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
  knowledgeFolders?: string[]
  knowledgeEnabled?: boolean
  captureSharedScreens?: boolean
  whatsNewSeen?: string
  liveNudges?: boolean
  aiProvider?: "openrouter" | "local"
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

export interface MeetingRecorderBridge {
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
  connectCalendar(): Promise<string>
  openCalendarPrivacy(): Promise<void>
  onCalendar(handler: (event: { title: string; attendees: string[]; startedAt?: number }) => void): void
  renameSpeaker(id: string, from: string, to: string): Promise<{ learned: boolean }>
  speakerNames(): Promise<string[]>
  voicesState(): Promise<VoicesState>
  retryVoiceModel(): Promise<boolean>
  forgetVoice(id: string): Promise<KnownVoice[]>
  onVoicesState(handler: (state: VoicesState) => void): void
  onRelabel(handler: (event: { startedAt: number; labels: Record<string, string> }) => void): void
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
  join(): void
  openSource(id: string): void
  resize(height: number): void
  action(name: "nudge:more" | "nudge:off"): void
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
