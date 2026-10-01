import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "@/index.css"

import { App } from "./App"
import { installCapture } from "./capture"

installCapture()
document.documentElement.style.background = "transparent"
document.body.style.background = "transparent"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
