import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Cancel01Icon, CheckmarkCircle02Icon, LinkSquare02Icon, Tick02Icon } from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { EmberMark } from "@/main-window/page"

type Step = "key" | "paste" | "setup" | "r2" | "failed" | "done"

interface GuideState {
  step: Step
  substep?: string
  url?: string | null
  message?: string | null
  canRetry?: boolean
}

declare global {
  interface Window {
    shareGuide: {
      state(): Promise<GuideState | null>
      action(action: string): void
      resize(height: number): void
      onState(handler: (state: GuideState) => void): () => void
    }
  }
}

const STAGES = [
  { id: "key", label: "Copy key" },
  { id: "paste", label: "Connect" },
  { id: "setup", label: "Set up" },
]

const SETUP_STEPS = [
  { id: "account", label: "Finding your Cloudflare account" },
  { id: "storage", label: "Making storage for your videos" },
  { id: "worker", label: "Publishing your share page" },
  { id: "check", label: "Checking it's live" },
]

function stageOf(step: Step) {
  return step === "key" ? 0 : step === "paste" ? 1 : step === "done" ? 3 : 2
}

function Steps({ items }: { items: React.ReactNode[] }) {
  return (
    <ol className="flex flex-col gap-2.5">
      {items.map((item, index) => (
        <li key={index} className="flex gap-3 text-[13.5px] leading-snug text-foreground/85">
          <span className="tabular mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-ember/15 text-[11.5px] font-semibold text-ember">{index + 1}</span>
          <span>{item}</span>
        </li>
      ))}
    </ol>
  )
}

const Strong = ({ children }: { children: React.ReactNode }) => <span className="font-medium text-foreground">{children}</span>

/** The floating walkthrough for setting up sharing, beside Cloudflare and Composio in the browser. */
export function Guide() {
  const [state, setState] = useState<GuideState | null>(null)
  const card = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.shareGuide.state().then((initial) => initial && setState(initial))
    return window.shareGuide.onState(setState)
  }, [])

  // The window fits the card, so nothing invisible covers the browser.
  useLayoutEffect(() => {
    const element = card.current
    if (!element) return
    const observer = new ResizeObserver(() => window.shareGuide.resize(element.offsetHeight + 16))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const act = (action: string) => () => window.shareGuide.action(action)
  const step = state?.step || "key"
  const stage = stageOf(step)

  let title = ""
  let body: React.ReactNode = null
  let actions: React.ReactNode = null

  if (step === "key") {
    title = "Copy your Cloudflare key"
    body = (
      <Steps
        items={[
          <>In the Cloudflare tab, scroll down to <Strong>API Keys</Strong>.</>,
          <>Next to <Strong>Global API Key</Strong>, click <Strong>View</Strong>, and confirm it's you.</>,
          <>Click <Strong>Copy</Strong>.</>,
        ]}
      />
    )
    actions = (
      <>
        <Button className="h-9 flex-1 rounded-full" onClick={act("copied")}>
          <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} /> I've copied it
        </Button>
        <Button variant="pill" className="h-9" onClick={act("open-keys")}>
          <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={1.8} /> Cloudflare
        </Button>
      </>
    )
  } else if (step === "paste") {
    title = "Paste it into Composio"
    body = (
      <>
        <Steps
          items={[
            <>In the Composio tab, paste the key into the <Strong>API key</Strong> box.</>,
            <>Type the <Strong>email</Strong> you sign in to Cloudflare with.</>,
            <>Click <Strong>Connect</Strong>.</>,
          ]}
        />
        <p className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
          <Spinner className="size-3.5 text-ember" /> Ember carries on as soon as it's connected.
        </p>
      </>
    )
    actions = state?.url ? (
      <Button variant="pill" className="h-9" onClick={act("open-link")}>
        <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={1.8} /> Open Composio again
      </Button>
    ) : null
  } else if (step === "setup") {
    title = "Setting up your share page"
    const current = SETUP_STEPS.findIndex((item) => item.id === state?.substep)
    body = (
      <ul className="flex flex-col gap-2.5">
        {SETUP_STEPS.map((item, index) => {
          const done = index < current
          const active = index === Math.max(0, current)
          return (
            <li key={item.id} className={cn("flex items-center gap-3 text-[13.5px]", done ? "text-foreground/85" : active ? "text-foreground" : "text-faint")}>
              <span className="flex size-5 shrink-0 items-center justify-center">
                {done ? <HugeiconsIcon icon={CheckmarkCircle02Icon} strokeWidth={1.8} className="size-[18px] text-ember" /> : active ? <Spinner className="size-4 text-ember" /> : <span className="size-1.5 rounded-full bg-white/20" />}
              </span>
              {item.label}
            </li>
          )
        })}
      </ul>
    )
    actions = <p className="text-[12.5px] text-faint">Nothing to do here. This takes up to a minute.</p>
  } else if (step === "r2") {
    title = "Turn on R2 storage"
    body = (
      <>
        <p className="text-[13.5px] text-muted-foreground">Cloudflare needs R2 switched on once. It's free up to 10 GB, though Cloudflare may ask for a card.</p>
        <Steps
          items={[
            <>In the Cloudflare tab, click <Strong>Purchase R2 Plan</Strong> (or Enable R2).</>,
            <>Choose the <Strong>free</Strong> plan and confirm.</>,
            <>Come back here and click <Strong>I've turned it on</Strong>.</>,
          ]}
        />
      </>
    )
    actions = (
      <>
        <Button className="h-9 flex-1 rounded-full" onClick={act("retry")}>
          I've turned it on
        </Button>
        <Button variant="pill" className="h-9" onClick={act("open-r2")}>
          <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={1.8} /> Cloudflare
        </Button>
      </>
    )
  } else if (step === "failed") {
    title = "That didn't work"
    body = (
      <p className="text-[13.5px] text-muted-foreground">
        {state?.message || "Something went wrong."}
        {state?.canRetry ? "" : " Close this and press Connect Cloudflare in Ember to try again."}
      </p>
    )
    actions = state?.canRetry ? (
      <>
        <Button className="h-9 flex-1 rounded-full" onClick={act("retry")}>
          Try again
        </Button>
        <Button variant="pill" className="h-9" onClick={act("cancel")}>
          Close
        </Button>
      </>
    ) : (
      <Button variant="pill" className="h-9" onClick={act("cancel")}>
        Close
      </Button>
    )
  } else {
    title = "Sharing is ready"
    body = (
      <p className="text-[13.5px] text-muted-foreground">
        Your share page is live
        {state?.url ? <span className="mt-1 block truncate font-mono text-[12px] text-faint">{state.url.replace(/^https:\/\//, "")}</span> : null}
      </p>
    )
    actions = (
      <Button className="h-9 flex-1 rounded-full" onClick={act("back")}>
        Back to Ember
      </Button>
    )
  }

  return (
    <div className="p-2">
      <div ref={card} className="drag flex flex-col gap-4 rounded-[20px] border border-white/10 bg-[#191919] p-5 shadow-[0_18px_60px_rgb(0_0_0/0.5)]">
        <header className="flex items-center gap-2.5">
          <EmberMark className="size-5" />
          <span className="text-[13px] font-medium text-muted-foreground">Set up sharing</span>
          <button
            type="button"
            aria-label="Close"
            title={step === "done" ? "Close" : "Cancel setup"}
            onClick={act("cancel")}
            className="no-drag ml-auto flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-white/[0.07] hover:text-foreground"
          >
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={1.8} className="size-4" />
          </button>
        </header>

        <div className="flex gap-1.5" aria-label={`Step ${Math.min(stage + 1, 3)} of 3`}>
          {STAGES.map((item, index) => (
            <div key={item.id} className="flex flex-1 flex-col gap-1.5">
              <span className={cn("h-1 rounded-full", index < stage ? "bg-ember" : index === stage ? "bg-[image:var(--ember-gradient)]" : "bg-white/10")} />
              <span className={cn("text-[11px]", index <= stage ? "text-foreground/80" : "text-faint")}>{item.label}</span>
            </div>
          ))}
        </div>

        <h2 className="text-[17px] font-semibold tracking-[-0.015em]">{title}</h2>
        <div className="no-drag flex flex-col gap-3">{body}</div>
        {actions ? <div className="no-drag flex items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  )
}
