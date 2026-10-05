import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Cancel01Icon } from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import type { SettingsState } from "@/types/bridge"

// Matches WHATS_NEW_VERSION in src/main.js, which new users get when they finish setup.
export const WHATS_NEW_VERSION = "1.10"

type Page = "meetings" | "dictation" | "clipboard"
type Target = Page | { settings: string }

const ITEMS: { title: string; text: string; action: string; target: Target }[] = [
  { title: "Grab text and clipboard", text: "⌘⇧2 copies text from anything on screen. ⌃⌘V pastes from everything you've copied.", action: "Open Clipboard", target: "clipboard" },
  { title: "Offline mode", text: "Run every AI feature on your Mac with Gemma 4. Free, private, no internet.", action: "Set up", target: { settings: "ai" } },
  { title: "Action items, sent", text: "Send them to Linear, Notion or Reminders, and save notes to Google Docs.", action: "Connect", target: { settings: "connections" } },
  { title: "Note templates", text: "Sales call, 1:1, Interview and Standup notes, picked from the calendar.", action: "Choose", target: { settings: "ai" } },
  { title: "In-person meetings", text: "Record a meeting in the room; everyone is told apart by voice.", action: "Settings", target: { settings: "zoom" } },
]

/** A one-time tour of what's new, for people who set the app up before this version. */
export function WhatsNew({ settings, onGo }: { settings: SettingsState | null | undefined; onGo: (page: Page) => void }) {
  const [hidden, setHidden] = useState(false)
  if (!settings || hidden || settings.whatsNewSeen === WHATS_NEW_VERSION) return null
  const dismiss = () => {
    setHidden(true)
    void window.meetingRecorder.saveSettings({ whatsNewSeen: WHATS_NEW_VERSION }).catch(() => {})
  }
  return (
    <section aria-label={`New in ${WHATS_NEW_VERSION}`} className="col-span-4 rounded-xl border border-gold/30 bg-panel p-5 max-[1100px]:col-span-2">
      <header className="mb-4 flex items-center justify-between">
        <h2 className="text-[15px] font-medium">
          <span className="gold-text font-semibold">New in {WHATS_NEW_VERSION}</span>
        </h2>
        <Button variant="ghost" size="icon-sm" aria-label="Dismiss" className="text-muted-foreground" onClick={dismiss}>
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
        </Button>
      </header>
      <ul className="grid grid-cols-5 gap-4 max-[1100px]:grid-cols-2">
        {ITEMS.map((item) => (
          <li key={item.title} className="flex flex-col gap-1">
            <p className="text-[13px] font-medium text-foreground">{item.title}</p>
            <p className="text-[12px] leading-[1.45] text-muted-foreground">{item.text}</p>
            <button
              type="button"
              className="mt-auto self-start pt-1 text-[12px] text-gold underline-offset-4 hover:underline"
              onClick={() => (typeof item.target === "string" ? onGo(item.target) : void window.meetingRecorder.openSettings(item.target.settings))}
            >
              {item.action}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
