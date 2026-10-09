import { useEffect, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Mic01Icon, StopIcon } from "@hugeicons/core-free-icons"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import type { RoleplayReply, Scorecard } from "@/types/bridge"

import { ScorecardView } from "./call-coach"
import { errorText } from "./meetings"

type Turn = RoleplayReply["history"][number]
type Options = Awaited<ReturnType<typeof window.meetingRecorder.roleplayScenarios>>

/**
 * Practice calls: the AI plays a prospect or client built from your knowledge base, so it raises the objections
 * your playbooks prepare you for. You answer out loud (or type), and get a review at the end.
 */
export function PracticePage() {
  const [options, setOptions] = useState<Options | null>(null)
  const [scenario, setScenario] = useState(() => localStorage.getItem("ember.practice.scenario") || "discovery")
  const [difficulty, setDifficulty] = useState(() => localStorage.getItem("ember.practice.difficulty") || "normal")
  const [custom, setCustom] = useState("")
  const [history, setHistory] = useState<Turn[] | null>(null)
  const [busy, setBusy] = useState<"" | "starting" | "listening" | "thinking" | "reviewing">("")
  const [typed, setTyped] = useState("")
  const [review, setReview] = useState<Scorecard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.meetingRecorder.roleplayScenarios().then(setOptions).catch(() => {})
    return () => {
      void window.meetingRecorder.cancelPractice().catch(() => {})
      void window.meetingRecorder.roleplayStopVoice().catch(() => {})
    }
  }, [])
  useEffect(() => bottom.current?.scrollIntoView({ block: "end", behavior: "smooth" }), [history, busy])

  const run = async (state: typeof busy, work: () => Promise<RoleplayReply | null>) => {
    setBusy(state)
    setError(null)
    try {
      const reply = await work()
      if (reply) setHistory([...reply.history])
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy("")
    }
  }

  const start = () => {
    localStorage.setItem("ember.practice.scenario", scenario)
    localStorage.setItem("ember.practice.difficulty", difficulty)
    setReview(null)
    setHistory([])
    void run("starting", () => window.meetingRecorder.roleplayStart({ scenario, difficulty, custom }))
  }

  const say = (text: string) => {
    if (!text.trim()) return
    setHistory((current) => [...(current || []), { role: "you", text }])
    void run("thinking", () => window.meetingRecorder.roleplaySay(text))
  }

  const toggleMic = async () => {
    setError(null)
    if (busy === "listening") {
      setBusy("thinking")
      try {
        const result = await window.meetingRecorder.stopPractice()
        if (result?.text) say(result.text)
        else {
          setBusy("")
          setError("Nothing was heard. Try again, a little closer to the microphone.")
        }
      } catch (caught) {
        setBusy("")
        setError(errorText(caught))
      }
      return
    }
    try {
      void window.meetingRecorder.roleplayStopVoice()
      await window.meetingRecorder.startPractice()
      setBusy("listening")
    } catch (caught) {
      setError(errorText(caught))
    }
  }

  const end = async () => {
    if (busy === "listening") await window.meetingRecorder.cancelPractice().catch(() => {})
    setBusy("reviewing")
    setError(null)
    try {
      const card = await window.meetingRecorder.roleplayEnd()
      setReview(card)
      if (!card) setHistory(null)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy("")
    }
  }

  if (review) {
    return (
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-5 px-10 pb-10">
        <ScorecardView card={review} />
        <div className="flex gap-2">
          <Button onClick={start}>Practise again</Button>
          <Button
            variant="pill"
            onClick={() => {
              setReview(null)
              setHistory(null)
            }}
          >
            Change scenario
          </Button>
        </div>
      </div>
    )
  }

  if (history) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-10">
          <div className="mx-auto flex max-w-[720px] flex-col gap-3 pb-6">
            {history.map((turn, index) => (
              <div key={index} className={cn("flex", turn.role === "you" ? "justify-end" : "justify-start")}>
                <p
                  className={cn(
                    "max-w-[80%] rounded-2xl px-4 py-2.5 text-[14px] leading-[1.5]",
                    turn.role === "you" ? "bg-ember/[0.14] text-foreground" : "border border-border bg-panel text-foreground/90",
                  )}
                >
                  {turn.text}
                </p>
              </div>
            ))}
            {busy === "starting" || busy === "thinking" ? (
              <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
                <Spinner className="size-3.5" /> {busy === "starting" ? "They're picking up…" : "They're thinking…"}
              </p>
            ) : null}
            {error ? <p className="text-[13px] text-rec">{error}</p> : null}
            <div ref={bottom} />
          </div>
        </div>
        <div className="border-t border-border px-10 py-4">
          <div className="mx-auto flex max-w-[720px] items-center gap-2">
            <Button
              size="lg"
              className={cn("shrink-0 gap-2", busy === "listening" && "bg-rec hover:bg-rec/90")}
              disabled={busy !== "" && busy !== "listening"}
              onClick={() => void toggleMic()}
            >
              <HugeiconsIcon icon={busy === "listening" ? StopIcon : Mic01Icon} strokeWidth={1.8} />
              {busy === "listening" ? "Done talking" : "Talk"}
            </Button>
            <form
              className="flex min-w-0 flex-1 gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                say(typed)
                setTyped("")
              }}
            >
              <Input value={typed} onChange={(event) => setTyped(event.target.value)} placeholder="Or type what you'd say" disabled={busy !== ""} />
            </form>
            <Button variant="pill" disabled={busy === "reviewing" || busy === "starting"} onClick={() => void end()}>
              {busy === "reviewing" ? <Spinner /> : null} End and review
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-5 px-10 pb-10">
      {options && !options.hasKnowledge ? (
        <p className="rounded-lg border border-border bg-white/[0.02] px-4 py-3 text-[13px] text-muted-foreground">
          Add your playbooks, objection handling or product notes as a knowledge base folder in Settings → Knowledge base, and the other side will raise your real objections and
          ask about your real product.
        </p>
      ) : null}
      <label className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
        Scenario
        <Select value={scenario} onValueChange={setScenario}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(options?.scenarios || []).map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.label}
              </SelectItem>
            ))}
            <SelectItem value="custom">Describe your own</SelectItem>
          </SelectContent>
        </Select>
      </label>
      {scenario === "custom" ? (
        <Textarea value={custom} onChange={(event) => setCustom(event.target.value)} placeholder="Who are they and what's the call? e.g. a CFO renewing who wants a 20% discount" rows={3} />
      ) : null}
      <div className="flex flex-col gap-1.5 text-[13px] text-muted-foreground">
        How tough
        <ToggleGroup type="single" variant="outline" value={difficulty} onValueChange={(value) => value && setDifficulty(value)} className="self-start">
          <ToggleGroupItem value="easy">Friendly</ToggleGroupItem>
          <ToggleGroupItem value="normal">Realistic</ToggleGroupItem>
          <ToggleGroupItem value="hard">Tough</ToggleGroupItem>
        </ToggleGroup>
      </div>
      {error ? <p className="text-[13px] text-rec">{error}</p> : null}
      <div className="flex items-center gap-3">
        <Button disabled={!options?.hasAi || (scenario === "custom" && !custom.trim())} onClick={start}>
          Start practice call
        </Button>
        <span className="text-[12.5px] text-faint">
          {!options?.hasAi ? "Needs AI: add a key or on-device model in Settings." : options.voice ? "They answer out loud. Turn that off in Settings → Coaching." : "Replies are shown, not spoken."}
        </span>
      </div>
    </div>
  )
}
