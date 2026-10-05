import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowRight02Icon, Cancel01Icon, SparklesIcon } from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import type { SettingsState } from "@/types/bridge"

import { IconTile } from "./page"

// Matches WHATS_NEW_VERSION in src/main.js, which new users get when they finish setup.
export const WHATS_NEW_VERSION = "1.10"

type Page = "meetings" | "dictation" | "clipboard" | "saved"
type Target = Page | { settings: string }

const ITEMS: { title: string; text: string; action: string; target: Target }[] = [
  { title: "Meeting Notes is now Ember", text: "A new name and look. And Saved: press ⌃⌘S in your browser to keep posts and pages in boards.", action: "Open Saved", target: "saved" },
  { title: "Grab text and clipboard", text: "⌘⇧2 copies text from anything on screen. ⌃⌘V pastes from everything you've copied.", action: "Open Clipboard", target: "clipboard" },
  { title: "Offline mode", text: "Run every AI feature on your Mac with Gemma 4. Free, private, no internet.", action: "Set up", target: { settings: "ai" } },
  { title: "Action items, sent", text: "Send them to Linear, Notion or Reminders, and save notes to Google Docs.", action: "Connect", target: { settings: "connections" } },
  { title: "Note templates", text: "Sales call, 1:1, Interview and Standup notes, picked from the calendar.", action: "Choose", target: { settings: "ai" } },
  { title: "In-person meetings", text: "Record a meeting in the room; everyone is told apart by voice.", action: "Settings", target: { settings: "zoom" } },
]

/** A one-time banner for what's new, for people who set the app up before this version. */
export function WhatsNew({ settings, onGo }: { settings: SettingsState | null | undefined; onGo: (page: Page) => void }) {
  const [hidden, setHidden] = useState(false)
  if (!settings || hidden || settings.whatsNewSeen === WHATS_NEW_VERSION) return null
  const dismiss = () => {
    setHidden(true)
    void window.meetingRecorder.saveSettings({ whatsNewSeen: WHATS_NEW_VERSION }).catch(() => {})
  }
  const go = (target: Target) => (typeof target === "string" ? onGo(target) : void window.meetingRecorder.openSettings(target.settings))
  const [lead, ...rest] = ITEMS
  return (
    <section aria-label={`New in ${WHATS_NEW_VERSION}`} className="relative flex items-center gap-5 rounded-2xl border border-border bg-panel px-6 py-5 max-[1060px]:flex-col max-[1060px]:items-start">
      <IconTile icon={SparklesIcon} tint="var(--ember)" />
      <div className="min-w-0 flex-1">
        <h2 className="text-[16px] font-semibold tracking-[-0.01em]">
          <span className="text-ember">New in {WHATS_NEW_VERSION}</span> · {lead.title}
        </h2>
        <p className="mt-1 text-[14px] text-muted-foreground">{lead.text}</p>
        <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-faint">
          {rest.map((item) => (
            <button key={item.title} type="button" className="underline-offset-4 hover:text-foreground hover:underline" onClick={() => go(item.target)}>
              {item.title}
            </button>
          ))}
        </p>
      </div>
      <Button variant="light" className="mr-8 h-10 px-5 text-[14px] max-[1060px]:mr-0" onClick={() => go(lead.target)}>
        {lead.action}
        <HugeiconsIcon icon={ArrowRight02Icon} strokeWidth={2} data-icon="inline-end" />
      </Button>
      <Button variant="ghost" size="icon-xs" aria-label="Dismiss" className="absolute top-3.5 right-3.5 text-faint" onClick={dismiss}>
        <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
      </Button>
    </section>
  )
}
