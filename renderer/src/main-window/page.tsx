import { HugeiconsIcon } from "@hugeicons/react"
import { AudioWave01Icon } from "@hugeicons/core-free-icons"

import { cn } from "@/lib/utils"

/** Ember's mark: the five-bar waveform in a flame gradient, yellow at the tips to ember red at the base. */
export function EmberMark({ className }: { className?: string }) {
  const bars = [6, 12, 16, 10, 6]
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <defs>
        <linearGradient id="ember-mark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffc15e" />
          <stop offset="0.5" stopColor="#ff7a2f" />
          <stop offset="1" stopColor="#e8492c" />
        </linearGradient>
      </defs>
      {bars.map((height, index) => (
        <rect key={index} x={2.4 + index * 4.1} y={12 - (height * 1.25) / 2} width={2.6} height={height * 1.25} rx={1.3} fill="url(#ember-mark)" />
      ))}
    </svg>
  )
}

/** The top of a page, after Eden: a large title with the app's mark, a line under it, actions on the right. */
export function PageHeader({
  title,
  subtitle,
  actions,
  beside,
  mark = true,
  className,
}: {
  title: React.ReactNode
  subtitle?: React.ReactNode
  actions?: React.ReactNode
  beside?: React.ReactNode
  mark?: boolean
  className?: string
}) {
  return (
    <header className={cn("flex flex-col gap-2", className)}>
      <div className="flex min-h-10 items-center gap-3">
        <h1 className="flex min-w-0 items-center gap-3 text-[30px] leading-none font-semibold tracking-[-0.028em] text-foreground">
          {mark ? <EmberMark className="size-[28px] shrink-0" /> : null}
          <span className="truncate">{title}</span>
        </h1>
        {beside}
        {actions ? <div className="no-drag ml-auto flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {subtitle ? <p className="text-[15px] text-muted-foreground">{subtitle}</p> : null}
    </header>
  )
}

/** A scrolling page with Eden's spacing, and a strip at the top to drag the window by. */
export function Page({ children, className, width = "max-w-[1180px]" }: { children: React.ReactNode; className?: string; width?: string }) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div aria-hidden className="drag absolute inset-x-0 top-0 z-10 h-9" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={cn("mx-auto flex w-full flex-col gap-8 px-10 pt-11 pb-12", width, className)}>{children}</div>
      </div>
    </div>
  )
}

/** A section heading outside its card, like Eden's "Analytics" and "Recents". */
export function SectionTitle({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between px-0.5">
      <h2 className="text-[15px] font-medium text-foreground/85">{children}</h2>
      {aside ? <span className="text-[13px] text-faint">{aside}</span> : null}
    </div>
  )
}

/** Eden's card surface: a raised panel with a hairline border and a 16 px radius. */
export function Card({ className, children, ...props }: React.ComponentProps<"section">) {
  return (
    <section className={cn("rounded-2xl border border-border bg-panel", className)} {...props}>
      {children}
    </section>
  )
}

/** The rounded square an icon sits in, on quick actions and banners. */
export function IconTile({ icon, className, tint }: { icon: typeof AudioWave01Icon; className?: string; tint?: string }) {
  return (
    <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-[11px] bg-tile", className)}>
      <HugeiconsIcon icon={icon} strokeWidth={1.7} className="size-[19px]" style={tint ? { color: tint } : undefined} />
    </span>
  )
}
