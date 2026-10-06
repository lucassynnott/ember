import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "@/index.css"
import { TooltipProvider } from "@/components/ui/tooltip"

import { EditorPage } from "@/editor/Editor"

import { App } from "./App"
import { connectMeetingStore } from "./store"

// A hidden window that makes a new recording's finished version, then closes.
const finishing = /^#auto-finish=(.+)$/.exec(window.location.hash)

if (finishing) {
  createRoot(document.getElementById("root")!).render(
    <div className="flex h-screen">
      <EditorPage id={decodeURIComponent(finishing[1])} auto onClose={() => window.close()} />
    </div>,
  )
} else {
  connectMeetingStore()
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <TooltipProvider delayDuration={400}>
        <App />
      </TooltipProvider>
    </StrictMode>,
  )
}
