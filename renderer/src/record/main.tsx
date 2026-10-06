import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "@/index.css"

import { App } from "./App"

// Every record window but the setup card floats over whatever is on screen.
document.documentElement.style.background = "transparent"
document.body.style.background = "transparent"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App role={window.location.hash.slice(1)} />
  </StrictMode>,
)
