import { useSyncExternalStore } from "react"

import type {
  Analysis,
  FinishingCall,
  MeetingSaved,
  PermissionState,
  Phase,
  SettingsState,
  TranscriptSegment,
  ZoomAutoRecordingState,
  ZoomState,
} from "@/types/bridge"

import { installRecorderEngine, setEngineStatusHandler } from "./recorder-engine"

export interface MeetingState {
  phase: Phase
  message: string
  engineMessage: string
  permissions: PermissionState
  zoom: ZoomState
  autoRecording: ZoomAutoRecordingState
  segments: TranscriptSegment[]
  analysis: Analysis
  startedAt: number | null
  endedAt: number | null
  saved: MeetingSaved | null
  settings: SettingsState | null
  calendar: { title: string; attendees: string[] } | null
  // Calls whose notes are still being written, possibly while the next one records.
  jobs: FinishingCall[]
  // Slides captured from the screen during this call.
  slides: { count: number; latest: string } | null
  // Lines dictated into this call ("action item …"), merged with Your notes when it ends.
  voiceNotes: string[]
}

const emptyAnalysis: Analysis = { summary: [], decisions: [], actionItems: [] }

let state: MeetingState = {
  phase: "idle",
  message: "Ready",
  engineMessage: "",
  permissions: { microphone: "unknown", screen: "unknown", accessibility: "unknown" },
  zoom: {},
  autoRecording: {},
  segments: [],
  analysis: emptyAnalysis,
  startedAt: null,
  calendar: null,
  jobs: [],
  slides: null,
  voiceNotes: [],
  endedAt: null,
  saved: null,
  settings: null,
}

const listeners = new Set<() => void>()

function update(patch: Partial<MeetingState> | ((current: MeetingState) => Partial<MeetingState>)) {
  const next = typeof patch === "function" ? patch(state) : patch
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useMeeting() {
  return useSyncExternalStore(subscribe, () => state)
}

export async function refreshSettings() {
  try {
    update({ settings: await window.meetingRecorder.getSettings() })
  } catch (error) {
    console.error("Could not load settings", error)
  }
}

let connected = false

// Subscribes to the main process once, outside React, so listeners never double up.
export function connectMeetingStore() {
  if (connected) return
  connected = true
  const bridge = window.meetingRecorder
  installRecorderEngine()
  setEngineStatusHandler((engineMessage) => update({ engineMessage }))

  bridge.onState(({ phase, message }) =>
    update((current) => ({
      phase,
      message,
      endedAt:
        phase !== "recording" && current.phase === "recording" ? Date.now() : current.endedAt,
    })),
  )
  bridge.onPermissionState((permissions) => update({ permissions }))
  bridge.onZoomState((zoom) => update({ zoom }))
  bridge.onZoomAutoRecordingState((autoRecording) => update({ autoRecording }))
  bridge.onMeetingReset((startedAt?: number) =>
    update({
      segments: [],
      analysis: emptyAnalysis,
      startedAt: typeof startedAt === "number" ? startedAt : Date.now(),
      endedAt: null,
      saved: null,
      calendar: null,
      slides: null,
      voiceNotes: [],
    }),
  )
  // Results for an earlier call arrive after the next one may have started, so each is matched to its call.
  const forCurrent = (startedAt: number | undefined, current: MeetingState) => startedAt === undefined || startedAt === current.startedAt
  bridge.onJobs((jobs) => update({ jobs }))
  bridge.onSlides(({ startedAt, count, latest }) => update((current) => (forCurrent(startedAt, current) ? { slides: { count, latest } } : {})))
  bridge.onCalendar((calendar) => update((current) => (forCurrent(calendar.startedAt, current) ? { calendar } : {})))
  bridge.onTranscript((segment) => update((current) => ({ segments: [...current.segments, segment] })))
  bridge.onVoiceNote(({ startedAt, line }) =>
    update((current) => (forCurrent(startedAt, current) ? { voiceNotes: [...current.voiceNotes, line] } : {})),
  )
  // When the call ends, live "Speaker 2" labels are tidied and known voices get their names.
  bridge.onRelabel(({ startedAt, labels }) =>
    update((current) => (!forCurrent(startedAt, current) ? {} : {
      segments: current.segments.map((segment) => {
        const live = (segment as { voiceLabel?: string }).voiceLabel
        return live && labels[live] ? { ...segment, speaker: labels[live] } : segment
      }),
    })),
  )
  bridge.onAnalysis((analysis) =>
    update((current) => (!forCurrent(analysis.startedAt, current) ? {} : {
      analysis: {
        summary: analysis.summary || [],
        decisions: analysis.decisions || [],
        actionItems: analysis.actionItems || [],
        provider: analysis.provider || analysis.summaryProvider,
      },
    })),
  )
  // Folder and Notion saves report separately; keep whatever each one confirmed.
  bridge.onMeetingSaved((saved) =>
    update((current) => (!forCurrent(saved.startedAt, current) ? {} : {
      saved: {
        notePath: saved.notePath ?? current.saved?.notePath ?? null,
        notion: Boolean(saved.notion || current.saved?.notion),
        notionUrl: saved.notionUrl ?? current.saved?.notionUrl ?? null,
      },
    })),
  )
  void refreshSettings()
  window.addEventListener("focus", () => void refreshSettings())
}

export const permissionsGranted = (permissions: PermissionState) =>
  permissions.microphone === "granted" && permissions.screen === "granted"
