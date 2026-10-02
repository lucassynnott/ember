import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Cancel01Icon } from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import type { SettingsState } from "@/types/bridge"

// Matches WHATS_NEW_VERSION in src/main.js, which new users get when they finish setup.
export const WHATS_NEW_VERSION = "1.9"

type Target = "meetings" | "dictation" | { settings: string }

const ITEMS: { title: string; text: string; action: string; target: Target }[] = [
  { title: "Speaking coach", text: "Talk share, pace, fillers and a tip for every call.", action: "Open a call", target: "meetings" },
  { title: "Live help and knowledge", text: "Ask during a call, with your own documents and MCP servers.", action: "Add knowledge", target: { settings: "knowledge" } },
  { title: "See what was shared", text: "Slides shared in a call are saved into the notes.", action: "Settings", target: { settings: "zoom" } },
  { title: "Dictation, upgraded", text: "History, snippets and whisper mode.", action: "Open Dictation", target: "dictation" },
  { title: "Claude, Cursor and Terminal", text: "Let your AI apps search your calls.", action: "Connect", target: { settings: "connect" } },
]

/** A one-time tour of what's new, for people who set the app up before this version. */
export function WhatsNew({ settings, onGo }: { settings: SettingsState | null | undefined; onGo: (page: "meetings" | "dictation") => void }) {
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
