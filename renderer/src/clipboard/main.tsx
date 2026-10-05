import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "@/index.css"
import { TooltipProvider } from "@/components/ui/tooltip"

import { App } from "./App"

document.documentElement.style.background = "transparent"
document.body.style.background = "transparent"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider delayDuration={400}>
      <App />
    </TooltipProvider>
  </StrictMode>,
)
