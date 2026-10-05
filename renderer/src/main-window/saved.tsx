import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Add01Icon,
  ArrowUpRight01Icon,
  Bookmark02Icon,
  Cancel01Icon,
  DashboardSquare01Icon,
  Delete02Icon,
  FilterIcon,
  GridViewIcon,
  Idea01Icon,
  Link04Icon,
  Menu01Icon,
  MoreHorizontalIcon,
  News01Icon,
  RefreshIcon,
  Search01Icon,
  SparklesIcon,
  Tag01Icon,
  Video02Icon,
} from "@hugeicons/core-free-icons"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Kbd } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import type { SavedBoard, SavedItem, SavedKind } from "@/types/bridge"

import { Masonry, relativeTime } from "./clipboard"
import { Page, PageHeader } from "./page"

const KINDS: { id: "" | SavedKind; label: string }[] = [
  { id: "", label: "Everything" },
  { id: "post", label: "Posts" },
  { id: "article", label: "Articles" },
  { id: "video", label: "Videos" },
  { id: "link", label: "Other links" },
]
const KIND_ICONS: Record<SavedKind, typeof Link04Icon> = { post: Bookmark02Icon, article: News01Icon, video: Video02Icon, link: Link04Icon }
const KIND_LABELS: Record<SavedKind, string> = { post: "Post", article: "Article", video: "Video", link: "Link" }

const looksLikeLink = (text: string) => /^\s*(https?:\/\/|www\.)\S+\s*$/i.test(text) || /^\s*[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*\s*$/i.test(text)

function stored(key: string) {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}
function store(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Only a convenience.
  }
}

/** Ticks the boards an item is on, or makes a new one for it. */
function BoardMenu({ item, boards, onNewBoard, children }: { item: SavedItem; boards: SavedBoard[]; onNewBoard: (item: SavedItem) => void; children: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="text-[12px] text-faint">Boards</DropdownMenuLabel>
        {boards.map((board) => (
          <DropdownMenuCheckboxItem
            key={board.id}
            checked={item.boards.includes(board.id)}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) => void window.meetingRecorder.savedSetBoard(item.id, board.id, Boolean(checked))}
          >
            {board.name}
          </DropdownMenuCheckboxItem>
        ))}
        {boards.length ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem onSelect={() => onNewBoard(item)}>
          <HugeiconsIcon icon={Add01Icon} strokeWidth={1.8} />
          New board…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Status({ item }: { item: SavedItem }) {
  if (item.status === "reading")
    return (
      <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <Spinner className="size-3.5" /> Reading the page…
      </p>
    )
  if (item.status === "failed")
    return (
      <p className="flex items-center gap-2 text-[13px] text-rec">
        Couldn't read it{item.error ? `: ${item.error}` : ""}
        <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => void window.meetingRecorder.savedRetry(item.id)}>
          <HugeiconsIcon icon={RefreshIcon} strokeWidth={1.8} />
          Try again
        </Button>
      </p>
    )
  return null
}

function Summary({ item }: { item: SavedItem }) {
  if (item.status === "tagging")
    return (
      <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <Spinner className="size-3.5 text-gold" /> Summarising…
      </p>
    )
  if (!item.summary) return null
  return (
    <p className="flex gap-2 text-[14px] leading-[1.5] text-foreground/85">
      <HugeiconsIcon icon={SparklesIcon} strokeWidth={1.8} className="mt-[3px] size-3.5 shrink-0 text-gold" />
      <span>{item.summary}</span>
    </p>
  )
}

function Tags({ item, onTag }: { item: SavedItem; onTag: (tag: string) => void }) {
  if (!item.tags.length) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {item.tags.map((tag) => (
        <button
          key={tag}
          type="button"
          className="rounded-full border border-border px-2.5 py-0.5 text-[12px] text-muted-foreground transition-colors hover:border-white/20 hover:text-foreground"
          onClick={() => onTag(tag)}
        >
          {tag}
        </button>
      ))}
    </div>
  )
}

function boardNames(item: SavedItem, boards: SavedBoard[]) {
  return item.boards.map((id) => boards.find((board) => board.id === id)?.name).filter(Boolean) as string[]
}

/** A saved post or page, laid out like Eden's Library cards. */
function SavedCard({ item, boards, onTag, onNewBoard }: { item: SavedItem; boards: SavedBoard[]; onTag: (tag: string) => void; onNewBoard: (item: SavedItem) => void }) {
  const icon = KIND_ICONS[item.kind] || Link04Icon
  const who = item.author || item.siteName
  const caption = [boardNames(item, boards)[0] || "Saved", relativeTime(item.savedAt), item.tags[0] || KIND_LABELS[item.kind]]
  return (
    <div className="mb-5">
      <article className="group flex flex-col gap-3.5 rounded-2xl border border-border bg-panel p-4 transition-colors hover:border-white/[0.16]">
        <header className="flex items-start gap-3">
          <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-tile text-[13px] font-semibold text-foreground/85">
            {(who || "?")[0].toUpperCase()}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate text-[14.5px] font-semibold text-foreground">{who}</span>
              {item.author && item.siteName ? <span className="truncate text-[12.5px] text-faint">{item.siteName}</span> : null}
            </span>
            <span className="text-[12.5px] text-faint">{relativeTime(item.savedAt)}</span>
          </span>
          <Button variant="pill" size="icon-sm" aria-label="Open" className="size-9 shrink-0 text-muted-foreground" onClick={() => void window.meetingRecorder.openSaved(item.id)}>
            <HugeiconsIcon icon={ArrowUpRight01Icon} strokeWidth={1.8} className="size-4" />
          </Button>
        </header>

        <Status item={item} />
        {item.title && item.kind !== "post" ? <h3 className="text-[15.5px] leading-[1.35] font-semibold text-foreground">{item.title}</h3> : null}
        {item.kind === "post" && item.excerpt ? (
          <p className="text-[15px] leading-[1.55] whitespace-pre-wrap text-foreground/90" style={{ display: "-webkit-box", WebkitLineClamp: 9, WebkitBoxOrient: "vertical", overflow: "hidden" }} data-selectable>
            {item.excerpt}
          </p>
        ) : null}
        {item.thumbnail ? <img src={item.thumbnail} alt="" className="w-full rounded-xl border border-border object-cover" /> : null}
        <Summary item={item} />
        {item.kind !== "post" && !item.summary && item.status === "ready" && (item.description || item.excerpt) ? (
          <p className="text-[13.5px] leading-[1.55] text-muted-foreground" style={{ display: "-webkit-box", WebkitLineClamp: 4, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
            {item.description || item.excerpt}
          </p>
        ) : null}
        <Tags item={item} onTag={onTag} />

        <footer className="flex items-center gap-1 text-[13px] text-muted-foreground">
          <BoardMenu item={item} boards={boards} onNewBoard={onNewBoard}>
            <Button variant="ghost" size="sm" className="-ml-2 h-7 gap-1.5 px-2 text-muted-foreground">
              <HugeiconsIcon icon={DashboardSquare01Icon} strokeWidth={1.8} className="size-4" />
              {item.boards.length ? `${item.boards.length} ${item.boards.length === 1 ? "board" : "boards"}` : "Add to board"}
            </Button>
          </BoardMenu>
          <Button variant="ghost" size="icon-sm" aria-label="Delete" className="size-7 text-muted-foreground" onClick={() => void window.meetingRecorder.savedRemove(item.id)}>
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={1.8} className="size-4" />
          </Button>
          <HugeiconsIcon icon={icon} strokeWidth={1.8} className="ml-auto size-[18px] text-foreground/70" />
        </footer>
      </article>
      <p className="mt-2 truncate px-1 text-[12.5px] text-faint">{caption.join("  •  ")}</p>
    </div>
  )
}

function SavedRow({ item, boards, onTag, onNewBoard }: { item: SavedItem; boards: SavedBoard[]; onTag: (tag: string) => void; onNewBoard: (item: SavedItem) => void }) {
  return (
    <article className="group flex items-start gap-4 rounded-2xl border border-border bg-panel px-4 py-3">
      {item.thumbnail ? (
        <img src={item.thumbnail} alt="" className="size-16 shrink-0 rounded-[10px] border border-border object-cover" />
      ) : (
        <span className="flex size-16 shrink-0 items-center justify-center rounded-[10px] bg-tile">
          <HugeiconsIcon icon={KIND_ICONS[item.kind] || Link04Icon} strokeWidth={1.7} className="size-5 text-muted-foreground" />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <button type="button" className="truncate text-left text-[14.5px] font-semibold text-foreground hover:underline" onClick={() => void window.meetingRecorder.openSaved(item.id)}>
          {item.title || item.url}
        </button>
        <p className="truncate text-[12.5px] text-faint">
          {[item.author || item.siteName, relativeTime(item.savedAt), ...boardNames(item, boards)].join("  •  ")}
        </p>
        <Status item={item} />
        {item.summary ? <p className="truncate text-[13.5px] text-foreground/80">{item.summary}</p> : null}
        <Tags item={item} onTag={onTag} />
      </div>
      <div className="flex shrink-0 items-start gap-1 opacity-60 transition-opacity group-hover:opacity-100">
        <BoardMenu item={item} boards={boards} onNewBoard={onNewBoard}>
          <Button variant="ghost" size="icon-sm" aria-label="Boards" className="text-muted-foreground">
            <HugeiconsIcon icon={DashboardSquare01Icon} strokeWidth={1.8} />
          </Button>
        </BoardMenu>
        <Button variant="ghost" size="icon-sm" aria-label="Delete" className="text-muted-foreground" onClick={() => void window.meetingRecorder.savedRemove(item.id)}>
          <HugeiconsIcon icon={Delete02Icon} strokeWidth={1.8} />
        </Button>
      </div>
    </article>
  )
}

/** Posts, articles and pages saved from across the web, laid out like Eden's Library. */
export function SavedPage({
  board,
  shortcut,
  aiReady,
  aiOn,
  onBoardGone,
}: {
  board: string
  shortcut?: string
  aiReady: boolean
  aiOn: boolean
  onBoardGone: () => void
}) {
  const [query, setQuery] = useState("")
  const [kind, setKind] = useState<"" | SavedKind>("")
  const [tag, setTag] = useState("")
  const [items, setItems] = useState<SavedItem[] | null>(null)
  const [boards, setBoards] = useState<SavedBoard[]>([])
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([])
  const [view, setView] = useState<"grid" | "list">(() => (stored("saved-view") === "list" ? "list" : "grid"))
  const [banner, setBanner] = useState(() => stored("saved-banner-dismissed") !== "1")
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null)
  const [naming, setNaming] = useState<{ item: SavedItem | null; mode: "new" | "rename" } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const current = boards.find((entry) => entry.id === board)
  const load = useCallback(async () => {
    const [list, nextBoards, nextTags] = await Promise.all([
      window.meetingRecorder.savedList({ query, board, tag, kind }).catch(() => ({ items: [], total: 0 })),
      window.meetingRecorder.savedBoards().catch(() => []),
      window.meetingRecorder.savedTags().catch(() => []),
    ])
    setItems(list.items)
    setBoards(nextBoards)
    setTags(nextTags)
  }, [query, board, tag, kind])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), looksLikeLink(query) ? 0 : 120)
    return () => window.clearTimeout(timer)
  }, [load, query])
  useEffect(() => window.meetingRecorder.onSavedChanged(() => void load()), [load])
  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => setMessage(null), 2600)
    return () => window.clearTimeout(timer)
  }, [message])

  const save = useCallback(
    async (text: string) => {
      try {
        const result = await window.meetingRecorder.saveLink(text.trim(), board && board !== "unsorted" ? board : null)
        setMessage({ tone: "ok", text: result.existing ? "Already saved, moved to the top" : "Saved" })
        setQuery("")
      } catch (failure) {
        setMessage({ tone: "error", text: (failure as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") })
      }
    },
    [board],
  )

  // ⌘V anywhere on the page saves a copied link.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return
      const text = event.clipboardData?.getData("text/plain") || ""
      if (looksLikeLink(text)) {
        event.preventDefault()
        void save(text)
      }
    }
    window.addEventListener("paste", onPaste)
    return () => window.removeEventListener("paste", onPaste)
  }, [save])

  const linkQuery = looksLikeLink(query)
  const title = board === "unsorted" ? "Not on a board" : current?.name || "Saved"

  return (
    <Page>
      <div className="flex flex-col gap-6">
        <PageHeader
          title={title}
          subtitle={
            current
              ? `${current.count} ${current.count === 1 ? "item" : "items"} on this board.`
              : board === "unsorted"
                ? "Saved items that aren't on a board yet."
                : "Posts, articles and pages you've saved from across the web, searchable in one place."
          }
          actions={
            <>
              {current ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label="Board options" className="text-muted-foreground">
                      <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={1.8} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem onSelect={() => setNaming({ item: null, mode: "rename" })}>Rename board</DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onSelect={() => setConfirmDelete(true)}>
                      Delete board…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              <Button variant="pill" className="h-10 px-4 text-[14px]" onClick={() => input.current?.focus()}>
                <HugeiconsIcon icon={Add01Icon} strokeWidth={1.8} data-icon="inline-start" />
                Save link
              </Button>
            </>
          }
        />

        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (linkQuery) void save(query)
          }}
        >
          <label className="flex h-[54px] items-center gap-3 rounded-full border border-border bg-white/[0.025] px-5 transition-colors focus-within:border-white/20">
            <HugeiconsIcon icon={linkQuery ? Link04Icon : Search01Icon} strokeWidth={1.8} className={cn("size-[18px] shrink-0", linkQuery ? "text-gold" : "text-muted-foreground")} />
            <input
              ref={input}
              value={query}
              placeholder="Search what you've saved, or paste a link to save it"
              aria-label="Search saved items or paste a link"
              className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint"
              onChange={(event) => setQuery(event.target.value)}
            />
            {linkQuery ? (
              <Button type="submit" variant="light" size="sm" className="h-8 px-4">
                Save
              </Button>
            ) : query ? (
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Clear search" className="rounded-full text-muted-foreground" onClick={() => setQuery("")}>
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
              </Button>
            ) : shortcut ? (
              <span className="flex shrink-0 items-center gap-2 text-[12.5px] text-faint">
                <Kbd>{shortcut}</Kbd> in your browser
              </span>
            ) : null}
          </label>
        </form>
        {message ? <p className={cn("-mt-3 px-5 text-[13px]", message.tone === "ok" ? "text-gold" : "text-rec")}>{message.text}</p> : null}

        <div className="-mt-1 flex items-center gap-1 text-[14px]">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className={cn("gap-1.5 px-2.5 text-[14px]", kind ? "text-foreground" : "text-muted-foreground")}>
                <HugeiconsIcon icon={FilterIcon} strokeWidth={1.8} className="size-4" />
                {kind ? KINDS.find((entry) => entry.id === kind)?.label : "Filter"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-44">
              <DropdownMenuRadioGroup value={kind} onValueChange={(value) => setKind(value as "" | SavedKind)}>
                {KINDS.map((entry) => (
                  <DropdownMenuRadioItem key={entry.id || "all"} value={entry.id}>
                    {entry.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <span aria-hidden className="mx-1.5 h-4 w-px bg-border" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" disabled={!tags.length} className={cn("gap-1.5 px-2.5 text-[14px]", tag ? "text-gold" : "text-muted-foreground")}>
                <HugeiconsIcon icon={Tag01Icon} strokeWidth={1.8} className="size-4" />
                {tag || "Tags"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-80 w-52 overflow-y-auto">
              <DropdownMenuRadioGroup value={tag} onValueChange={setTag}>
                <DropdownMenuRadioItem value="">All tags</DropdownMenuRadioItem>
                {tags.map((entry) => (
                  <DropdownMenuRadioItem key={entry.tag} value={entry.tag}>
                    <span className="flex-1">{entry.tag}</span>
                    <span className="tabular text-[12px] text-faint">{entry.count}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          {tag ? (
            <Button variant="ghost" size="icon-xs" aria-label="Clear tag" className="text-faint" onClick={() => setTag("")}>
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
            </Button>
          ) : null}
          <div className="ml-auto flex items-center gap-0.5 rounded-[10px] bg-white/[0.05] p-0.5" role="radiogroup" aria-label="View">
            {(
              [
                ["grid", GridViewIcon, "Grid"],
                ["list", Menu01Icon, "List"],
              ] as const
            ).map(([id, icon, label]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={view === id}
                aria-label={label}
                className={cn("flex size-8 items-center justify-center rounded-[8px] transition-colors", view === id ? "bg-white/[0.1] text-foreground" : "text-faint hover:text-muted-foreground")}
                onClick={() => {
                  setView(id)
                  store("saved-view", id)
                }}
              >
                <HugeiconsIcon icon={icon} strokeWidth={1.8} className="size-4" />
              </button>
            ))}
          </div>
        </div>

        {banner ? (
          <section className="relative flex gap-3 rounded-2xl border border-gold/20 bg-gold/[0.04] px-5 py-4">
            <HugeiconsIcon icon={Idea01Icon} strokeWidth={1.8} className="mt-0.5 size-[18px] shrink-0 text-gold" />
            <div className="flex flex-col gap-1 pr-6 text-[14px] leading-[1.6]">
              <h2 className="font-semibold text-foreground">Save anything from the web</h2>
              <p className="text-muted-foreground">
                {shortcut
                  ? `Press ${shortcut} in Safari, Chrome, Arc, Brave or Edge to save the page you're on, or copy a link anywhere and press ${shortcut}. `
                  : ""}
                You can also paste a link here. Posts on X keep their full text.{" "}
                {aiReady && aiOn
                  ? "Each one gets a one-line summary and tags, so it's easy to find again."
                  : aiReady
                    ? "Turn on summaries in Settings → Clipboard to get a one-line summary and tags for each."
                    : "Set up AI in Settings → AI notes to get a one-line summary and tags for each."}{" "}
                Sort them into boards from the sidebar.
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss"
              className="absolute top-3 right-3 text-faint"
              onClick={() => {
                setBanner(false)
                store("saved-banner-dismissed", "1")
              }}
            >
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
            </Button>
          </section>
        ) : null}

        {items && !items.length ? (
          <Empty className="border-0 py-16">
            <EmptyHeader>
              <EmptyTitle className="text-[16px]">{query || kind || tag ? "No matches" : current ? "Nothing on this board yet" : "Nothing saved yet"}</EmptyTitle>
              <EmptyDescription>
                {query || kind || tag
                  ? "Try other words or another filter."
                  : current
                    ? "Use Add to board on any saved item, or save a link while this board is open."
                    : "Paste a link above, or press the shortcut in your browser."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : view === "grid" ? (
          <Masonry
            items={items || []}
            minWidth={290}
            render={(item) => <SavedCard key={item.id} item={item} boards={boards} onTag={setTag} onNewBoard={(target) => setNaming({ item: target, mode: "new" })} />}
          />
        ) : (
          <div className="flex flex-col gap-2">
            {(items || []).map((item) => (
              <SavedRow key={item.id} item={item} boards={boards} onTag={setTag} onNewBoard={(target) => setNaming({ item: target, mode: "new" })} />
            ))}
          </div>
        )}
      </div>

      <BoardNameDialog
        open={Boolean(naming)}
        title={naming?.mode === "rename" ? "Rename board" : "New board"}
        initial={naming?.mode === "rename" ? current?.name || "" : ""}
        onClose={() => setNaming(null)}
        onSubmit={async (name) => {
          if (naming?.mode === "rename" && current) await window.meetingRecorder.renameBoard(current.id, name)
          else {
            const created = await window.meetingRecorder.createBoard(name)
            if (naming?.item) await window.meetingRecorder.savedSetBoard(naming.item.id, created.id, true)
          }
          setNaming(null)
        }}
      />
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the {current?.name} board?</AlertDialogTitle>
            <AlertDialogDescription>Its items aren't deleted. They stay in Saved.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                if (current) await window.meetingRecorder.removeBoard(current.id)
                onBoardGone()
              }}
            >
              Delete board
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  )
}

/** Asks for a board's name. */
export function BoardNameDialog({
  open,
  title,
  initial,
  onClose,
  onSubmit,
}: {
  open: boolean
  title: string
  initial: string
  onClose: () => void
  onSubmit: (name: string) => Promise<void>
}) {
  const [name, setName] = useState(initial)
  const [error, setError] = useState("")
  useEffect(() => {
    if (open) {
      setName(initial)
      setError("")
    }
  }, [open, initial])
  const ready = useMemo(() => name.trim().length > 0, [name])
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onClose()}>
      <AlertDialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={async (event) => {
            event.preventDefault()
            if (!ready) return
            try {
              await onSubmit(name.trim())
            } catch (failure) {
              setError((failure as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""))
            }
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
          </AlertDialogHeader>
          <input
            autoFocus
            value={name}
            placeholder="e.g. Pricing research"
            aria-label="Board name"
            className="h-10 rounded-[10px] border border-border bg-white/[0.03] px-3 text-[14px] outline-none focus:border-white/25"
            onChange={(event) => setName(event.target.value)}
          />
          {error ? <p className="text-[13px] text-rec">{error}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
            <Button type="submit" disabled={!ready}>
              {title === "Rename board" ? "Rename" : "Create board"}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  )
}
