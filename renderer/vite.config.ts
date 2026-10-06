import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// The Electron windows, loaded from disk with relative asset paths.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome130",
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        settings: resolve(import.meta.dirname, "settings.html"),
        dictation: resolve(import.meta.dirname, "dictation.html"),
        onboarding: resolve(import.meta.dirname, "onboarding.html"),
        "ask-card": resolve(import.meta.dirname, "ask-card.html"),
        clipboard: resolve(import.meta.dirname, "clipboard.html"),
        record: resolve(import.meta.dirname, "record.html"),
        capture: resolve(import.meta.dirname, "capture.html"),
      },
    },
  },
})
