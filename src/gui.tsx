import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { OpenCode } from "@opencode/client"
import { MenuItem, Panel, Plugin } from "@opencode/plugin/gui"
import type { IpcClient, IpcProvider, MountedSession, PanelProps } from "@opencode/plugin/gui"
import { ArenaBridge, ArenaRpc, type BridgeState, type SendRequest, type WatchRequest } from "./gui-contract.ts"
import type { Attachment, RoomMessage, RoomParticipant } from "./types.ts"

function asText(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value
  if (value === undefined || value === null) return fallback
  if (value instanceof Error) return value.message || fallback
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    if (typeof record.text === "string") return record.text
    if (typeof record.reason === "string") return record.reason
    if (typeof record.message === "string") return record.message
    if (typeof record._tag === "string") return `${record._tag}${record.message ? `: ${String(record.message)}` : ""}`
    const nested = record.error
    if (typeof nested === "string") return nested
    if (nested && typeof nested === "object" && typeof (nested as Record<string, unknown>).message === "string") {
      return String((nested as Record<string, unknown>).message)
    }
    try {
      return JSON.stringify(value)
    } catch {
      return fallback
    }
  }
  return String(value)
}

type BridgeClient = IpcClient<typeof ArenaBridge.spec>

const css = `
.arena-root { position:relative; display:flex; flex-direction:column; height:100%; min-height:0; color:#e4e4e7; background:#18181b; font-size:12px; user-select:text; -webkit-user-select:text; }
.arena-title { display:flex; align-items:center; gap:8px; font-weight:650; font-size:13px; color:#f4f4f5; }
.arena-sub { color:#a1a1aa; font-size:11px; }
.arena-dot { width:7px; height:7px; border-radius:999px; display:inline-block; }
.arena-messages { flex:1; overflow:auto; padding:12px; display:flex; flex-direction:column; gap:10px; min-height:0; user-select:text !important; -webkit-user-select:text !important; -webkit-app-region:no-drag; }
.arena-row { display:flex; gap:8px; align-items:flex-start; max-width:100%; user-select:text !important; -webkit-user-select:text !important; }
.arena-row.user { justify-content:flex-end; }
.arena-row.system { justify-content:center; }
.arena-avatar { width:26px; height:26px; border-radius:9px; color:#fff; display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:700; flex:none; }
.arena-bubble { border-radius:12px; padding:8px 10px; background:#27272a; border:1px solid #3f3f46; color:#f4f4f5; max-width:82%; min-width:0; }
.arena-row.user .arena-bubble { background:#2563eb; border-color:transparent; color:#fff; }
.arena-bubble.system { background:transparent; border-style:dashed; color:#a1a1aa; max-width:92%; font-size:11px; }
.arena-bubble.goal { border-color:#ca8a04; background:#3f3a1a; }
.arena-name { font-size:11px; font-weight:650; display:flex; align-items:center; gap:6px; margin-bottom:3px; color:#f4f4f5; cursor:text; user-select:text !important; -webkit-user-select:text !important; }
.arena-row.user .arena-name { color:#fff; }
.arena-meta { font-size:10px; color:#a1a1aa; font-weight:400; user-select:text !important; -webkit-user-select:text !important; }
.arena-row.user .arena-meta { color:#dbeafe; }
.arena-text { white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.45; color:#f4f4f5; cursor:text; user-select:text !important; -webkit-user-select:text !important; -webkit-app-region:no-drag; }
.arena-row.user .arena-text { color:#fff; }
.arena-bubble.system .arena-text { color:#a1a1aa; }
.arena-detail { margin-top:6px; }
.arena-detail summary { cursor:pointer; color:#93c5fd; font-size:10px; }
.arena-detail-body { margin:6px 0 0; white-space:pre-wrap; overflow-wrap:anywhere; font:inherit; font-size:11px; color:#d4d4d8; cursor:text; user-select:text !important; -webkit-user-select:text !important; }
.arena-badge { font-size:9px; text-transform:uppercase; letter-spacing:.04em; border:1px solid currentColor; border-radius:4px; padding:0 4px; opacity:.8; }
.arena-composer { border-top:1px solid #3f3f46; padding:10px 12px; display:flex; flex-direction:column; gap:8px; }
.arena-typing { padding:6px 12px 0; color:#a1a1aa; font-size:11px; }
.arena-closed { margin:0 12px 8px; padding:6px 8px; border:1px solid #ca8a04; border-radius:7px; background:#3f3a1a; color:#fde68a; font-size:11px; }
.arena-hud { display:flex; flex-direction:column; gap:4px; padding:7px 12px; border-bottom:1px solid #3f3f46; }
.arena-hud-row { position:relative; display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding-right:32px; font-size:11px; color:#a1a1aa; }
.arena-status { display:inline-flex; align-items:center; gap:5px; text-transform:uppercase; letter-spacing:.06em; font-weight:700; color:#86efac; }
.arena-status.decide { color:#fbbf24; }
.arena-status.done { color:#a1a1aa; }
.arena-status.failed { color:#f87171; }
.arena-clock { color:#d4d4d8; font-variant-numeric:tabular-nums; }
.arena-clock .of { color:#71717a; }
.arena-hud-pill { display:inline-flex; align-items:center; gap:4px; border:1px solid #3f3f46; border-radius:5px; padding:1px 6px; font-size:10px; line-height:1.5; white-space:nowrap; }
.arena-hud-pill.test { color:#fbbf24; border-color:#78350f; background:#2a2113; }
.arena-hud-pill.oracle { color:#6ee7b7; border-color:#065f46; background:#0f2b22; }
.arena-hud-pill.oracle.pending { color:#fbbf24; border-color:#78350f; background:#2a2113; }
.arena-hud-pill.alert { color:#fbbf24; border-color:#92400e; background:#2a2113; }
.arena-hud-pill.claim { color:#c4b5fd; border-color:#4c1d95; background:#1e1533; }
.arena-hud-pill.verdict { color:#f4f4f5; border-color:#52525b; }
.arena-hud-pill.bad { color:#fca5a5; border-color:#7f1d1d; background:#2a1414; }
.arena-facts { color:#a1a1aa; font-size:10px; }
.arena-facts b { color:#d4d4d8; font-weight:600; }
.arena-crew-row { display:flex; align-items:center; gap:7px; min-width:0; overflow:hidden; font-size:10px; }
.arena-crew-label { text-transform:uppercase; letter-spacing:.08em; font-size:9px; color:#52525b; flex:none; }
.arena-crew-working { color:#d4d4d8; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.arena-crew-working::before { content:"●"; color:#22c55e; margin-right:4px; }
.arena-crew-idle { color:#71717a; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.arena-crew-idle::before { content:"○"; margin-right:4px; }
.arena-crew-more { color:#52525b; flex:none; }
.arena-compose-row { display:flex; align-items:center; gap:6px; }
.arena-inline-error { padding:4px 12px; }
.arena-icon-btn { box-sizing:border-box; width:34px; height:34px; flex:none; display:inline-flex; align-items:center; justify-content:center; border:1px solid #3f3f46; border-radius:9px; background:#27272a; color:#e4e4e7; font:inherit; font-size:18px; line-height:1; cursor:pointer; padding:0; user-select:none; -webkit-user-select:none; }
.arena-icon-btn:hover { background:#3f3f46; }
.arena-icon-btn:focus-visible { outline:2px solid #93c5fd; outline-offset:2px; }
.arena-icon-btn:disabled { opacity:.45; cursor:default; }
.arena-icon-btn.send { color:#fff; background:#2563eb; border-color:transparent; }
.arena-icon-btn.send:hover { background:#1d4ed8; }
.arena-input { box-sizing:border-box; flex:1; width:auto; resize:none; height:34px; min-height:34px; max-height:120px; border:1px solid #3f3f46; border-radius:9px; background:#18181b; color:#f4f4f5; padding:7px 10px; font:inherit; line-height:1.35; outline:none; }
.arena-input:focus { border-color:#2563eb; }
.arena-stop { box-sizing:border-box; position:absolute; right:0; top:0; width:24px; height:24px; flex:none; display:inline-flex; align-items:center; justify-content:center; border:1px solid #ef4444; border-radius:999px; background:#7f1d1d; color:#fecaca; font:inherit; font-size:14px; line-height:1; cursor:pointer; padding:0; }
.arena-stop:hover { background:#991b1b; color:#fff; }
.arena-stop:disabled { opacity:.35; cursor:default; }
.arena-hidden { display:none; }
.arena-composer.dragging { outline:2px dashed #2563eb; outline-offset:-4px; }
.arena-attach-row { display:flex; flex-wrap:wrap; gap:6px; }
.arena-attach-chip { position:relative; display:flex; align-items:center; gap:4px; border:1px solid #3f3f46; border-radius:8px; background:#27272a; padding:4px 6px; max-width:100%; }
.arena-attach-thumb { width:56px; height:56px; object-fit:cover; border-radius:6px; display:block; }
.arena-attach-name { font-size:10px; color:#d4d4d8; max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.arena-attach-x { border:0; background:transparent; color:#fca5a5; cursor:pointer; font-size:14px; line-height:1; padding:0 2px; }
.arena-attachments { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
.arena-attach-image { max-width:220px; max-height:180px; border-radius:8px; display:block; }
.arena-image-button { padding:0; border:0; background:transparent; display:block; max-width:100%; cursor:zoom-in; }
.arena-image-button:focus-visible { outline:2px solid #93c5fd; outline-offset:3px; border-radius:9px; }
.arena-attach-file { font-size:10px; border:1px solid #3f3f46; border-radius:6px; padding:2px 6px; color:#d4d4d8; }
.arena-lightbox { position:absolute; inset:0; z-index:100; display:flex; align-items:center; justify-content:center; padding:28px; background:rgba(0,0,0,.88); cursor:zoom-out; user-select:none; -webkit-user-select:none; }
.arena-lightbox-image { max-width:100%; max-height:100%; object-fit:contain; border-radius:8px; box-shadow:0 18px 60px rgba(0,0,0,.65); cursor:default; }
.arena-lightbox-close { position:absolute; top:10px; right:10px; width:30px; height:30px; border-radius:999px; border:1px solid #52525b; background:#18181b; color:#f4f4f5; font-size:18px; line-height:1; cursor:pointer; }
.arena-lightbox-close:hover { background:#27272a; }
.arena-lightbox-name { position:absolute; left:50%; bottom:12px; transform:translateX(-50%); max-width:90%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#d4d4d8; font-size:11px; }
.arena-btn { border:1px solid #3f3f46; background:#27272a; color:#e4e4e7; border-radius:7px; padding:4px 9px; font-size:11px; cursor:pointer; user-select:none; -webkit-user-select:none; }
.arena-btn, .arena-select, .arena-avatar, .arena-badge, .arena-hud, .arena-closed, .arena-typing { -webkit-user-select:none; user-select:none; }
.arena-btn:hover { background:#3f3f46; }
.arena-btn.primary { background:#2563eb; color:#fff; border-color:transparent; }
.arena-btn.danger { color:#fca5a5; border-color:#7f1d1d; }
.arena-btn:disabled { opacity:.5; cursor:default; }
.arena-empty { color:#a1a1aa; text-align:center; padding:28px 14px; line-height:1.5; }
.arena-error { color:#fca5a5; font-size:11px; }
.arena-root .arena-messages, .arena-root .arena-row, .arena-root .arena-text,
.arena-root .arena-name, .arena-root .arena-meta, .arena-root .arena-detail-body {
  user-select:text !important;
  -webkit-user-select:text !important;
}
`

function timeOf(value: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(value))
  } catch {
    return ""
  }
}

function Avatar(props: { label: string; color: string }) {
  const text = props.label === "User" ? "You" : props.label === "Orchestrator" ? "Or" : props.label.slice(0, 2)
  return (
    <div class="arena-avatar" style={{ background: props.color }}>
      {text}
    </div>
  )
}

type ImagePreview = { src: string; alt: string; name: string }

function Bubble(props: {
  message: RoomMessage
  participants: RoomParticipant[]
  onPreview: (preview: ImagePreview) => void
}) {
  const message = props.message
  const participant = () => props.participants.find((item) => item.label === message.author)
  const color = () => participant()?.color ?? (message.authorRole === "user" ? "#2563eb" : "#52525b")
  const system = message.authorRole === "system"
  const user = message.authorRole === "user"
  const goal = message.kind === "goal"
  return (
    <div class={`arena-row${user ? " user" : ""}${system ? " system" : ""}`}>
      <Show when={!user && !system}>
        <Avatar label={message.author} color={color()} />
      </Show>
      <div class={`arena-bubble${system ? " system" : ""}${goal ? " goal" : ""}`}>
        <Show when={!system}>
          <div class="arena-name" style={{ color: user ? "#fff" : color() }}>
            {user ? "You" : message.author}
            <Show when={participant()?.stance}>
              <span class="arena-meta">{participant()?.stance}</span>
            </Show>
            <span class="arena-meta">{timeOf(message.at)}</span>
            <Show when={message.order}>
              <span class="arena-badge">order</span>
            </Show>
            <Show when={message.private}>
              <span class="arena-badge">private</span>
            </Show>
            <Show when={goal}>
              <span class="arena-badge">goal</span>
            </Show>
            <Show when={message.kind === "claim"}>
              <span class="arena-badge">claim</span>
            </Show>
            <Show when={message.kind === "dead-end"}>
              <span class="arena-badge">dead end</span>
            </Show>
            <Show when={message.kind === "request"}>
              <span class="arena-badge">request</span>
            </Show>
          </div>
        </Show>
        <div class="arena-text">{asText(message.text)}</div>
        <Show when={message.meta?.attachments?.length}>
          <div class="arena-attachments">
            <For each={message.meta?.attachments ?? []}>
              {(attachment) => (
                <Show
                  when={attachment.mime.startsWith("image/")}
                  fallback={<span class="arena-attach-file">{attachment.name}</span>}
                >
                  {(() => {
                    const src = `data:${attachment.mime};base64,${attachment.data}`
                    return (
                      <button
                        type="button"
                        class="arena-image-button"
                        title={`Open ${attachment.name}`}
                        aria-label={`Open image ${attachment.name}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          props.onPreview({ src, alt: attachment.name, name: attachment.name })
                        }}
                      >
                        <img class="arena-attach-image" src={src} alt={attachment.name} />
                      </button>
                    )
                  })()}
                </Show>
              )}
            </For>
          </div>
        </Show>
        <Show when={message.meta?.detail}>
          <details class="arena-detail">
            <summary>details</summary>
            <pre class="arena-detail-body">{message.meta?.detail}</pre>
          </details>
        </Show>
      </div>
      <Show when={user}>
        <Avatar label="You" color={color()} />
      </Show>
    </div>
  )
}

function ArenaChat(props: { bridge: BridgeClient; session: MountedSession }) {
  const [text, setText] = createSignal("")
  const [sending, setSending] = createSignal(false)
  const [notice, setNotice] = createSignal("")
  const [attachments, setAttachments] = createSignal<Attachment[]>([])
  const [dragging, setDragging] = createSignal(false)
  const [preview, setPreview] = createSignal<ImagePreview | null>(null)
  let listRef: HTMLDivElement | undefined
  let lightboxRef: HTMLDivElement | undefined
  let fileInput: HTMLInputElement | undefined

  const state = () => props.bridge.state() as BridgeState | undefined
  const room = createMemo(() => state()?.room)
  const field = createMemo(() => state()?.field)
  const messages = createMemo(() => room()?.messages ?? [])
  const participants = createMemo(() => room()?.participants ?? [])
  const agents = createMemo(() => participants().filter((item) => item.role === "agent"))

  createEffect(() => {
    if (!preview()) return
    queueMicrotask(() => lightboxRef?.focus())
  })
  const typing = createMemo(() => agents().filter((item) => item.typing).map((item) => item.label))
  const closed = createMemo(() => room()?.closed === true)
  const statusColor = createMemo(() => {
    const status = field()?.status
    if (status === "done") return field()?.closed?.decision === "accepted" ? "#22c55e" : "#a1a1aa"
    if (status === "failed") return "#ef4444"
    return "#22c55e"
  })
  const activeExperiment = createMemo(() => field()?.experiments?.find((experiment) => experiment.status === "running"))
  const experimentClock = createMemo(() => {
    const started = activeExperiment()?.startedAt
    if (!started) return ""
    const total = Math.max(0, Math.round((Date.now() - started) / 1_000))
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
  })
  const workingCrew = createMemo(() => field()?.members.filter((member) => member.status === "working") ?? [])
  const idleCrew = createMemo(() => field()?.members.filter((member) => member.status === "idle") ?? [])
  const leftCrew = createMemo(() => field()?.members.filter((member) => member.status === "left") ?? [])
  const otherCrew = createMemo(
    () =>
      field()?.members.filter(
        (member) => member.status !== "working" && member.status !== "idle" && member.status !== "left",
      ) ?? [],
  )
  const crewNames = (list: { label: string }[], max = 6): string => {
    const shown = list.slice(0, max).map((member) => member.label)
    return shown.join(" · ") + (list.length > max ? ` +${list.length - max}` : "")
  }

  createEffect(() => {
    void props.bridge.watch({ serverID: props.session.server.id, sessionID: props.session.id })
  })

  createEffect(() => {
    messages().length
    const scroll = () => {
      if (listRef) listRef.scrollTop = listRef.scrollHeight
    }
    queueMicrotask(scroll)
    requestAnimationFrame(scroll)
  })

  const MAX_FILES = 4
  const MAX_BYTES = 8 * 1024 * 1024
  const dataUrlOf = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error ?? new Error("Could not read the file"))
      reader.readAsDataURL(file)
    })

  const shrinkImage = async (dataUrl: string, mime: string): Promise<string> => {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error("Could not decode the image"))
      element.src = dataUrl
    })
    const limit = 1600
    if (image.width <= limit && image.height <= limit && dataUrl.length < 3_000_000) return dataUrl
    const scale = Math.min(1, limit / Math.max(image.width, image.height))
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(image.width * scale))
    canvas.height = Math.max(1, Math.round(image.height * scale))
    const context = canvas.getContext("2d")
    if (!context) return dataUrl
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL(mime === "image/png" ? "image/png" : "image/jpeg", 0.85)
  }

  const addFiles = async (list: FileList | File[]) => {
    const incoming = Array.from(list).slice(0, MAX_FILES - attachments().length)
    if (incoming.length === 0) return
    const next: Attachment[] = []
    for (const file of incoming) {
      if (file.size > MAX_BYTES) {
        setNotice(`${file.name} is too large (max 8 MB)`)
        continue
      }
      try {
        let dataUrl = await dataUrlOf(file)
        if (file.type.startsWith("image/")) dataUrl = await shrinkImage(dataUrl, file.type)
        const comma = dataUrl.indexOf(",")
        if (comma < 0) continue
        next.push({
          name: file.name || (file.type.startsWith("image/") ? "image" : "file"),
          mime: file.type || "application/octet-stream",
          data: dataUrl.slice(comma + 1),
        })
      } catch (error) {
        setNotice(asText(error, `Could not attach ${file.name}`))
      }
    }
    if (next.length > 0) setAttachments([...attachments(), ...next].slice(0, MAX_FILES))
  }

  const removeAttachment = (index: number) => {
    setAttachments(attachments().filter((_, position) => position !== index))
  }

  const send = async () => {
    if (closed() || sending()) return
    const value = text().trim()
    if (value.length === 0 && attachments().length === 0) return
    setSending(true)
    setNotice("")
    try {
      // One composer: the text is the message. An @Name typed in the text is the
      // only way to focus a specific agent; there is no separate selector.
      await props.bridge.send({
        sessionID: props.session.id,
        text: value,
        to: "all",
        private: false,
        attachments: attachments(),
      })
      setText("")
      setAttachments([])
    } catch (error) {
      setNotice(asText(error, "Send failed"))
    } finally {
      setSending(false)
    }
  }

  const stopArena = async () => {
    if (closed() || sending() || !field()?.runID || field()?.status === "done") return
    if (typeof confirm === "function" && !confirm("Terminate the Arena for everyone? This cannot be undone.")) return
    setSending(true)
    setNotice("")
    try {
      await props.bridge.send({ sessionID: props.session.id, text: "stop", to: "all", private: false })
    } catch (error) {
      setNotice(asText(error, "Could not terminate the Arena"))
    } finally {
      setSending(false)
    }
  }

  return (
    <div class="arena-root">
      <style>{css}</style>
      <Show when={field()?.runID && field()}>
        <div class="arena-hud">
          <div class="arena-hud-row">
            <span class={`arena-status ${field()!.status}`}>
              <span class="arena-dot" style={{ background: statusColor() }} />
              {field()!.status}
            </span>
            <span class="arena-clock">
              {Math.round(field()!.elapsedMs / 60_000)}
              <Show when={field()!.budgetMs > 0} fallback={<span class="of">m · live</span>}>
                <span class="of">m / </span>
                {Math.round(field()!.budgetMs / 60_000)}m
              </Show>
            </span>
            <Show when={activeExperiment()}>
              <span
                class="arena-hud-pill test"
                title={`${activeExperiment()!.owner}: ${activeExperiment()!.hypothesis}`}
              >
                {activeExperiment()!.id} · {experimentClock() || "running"}
              </span>
            </Show>
            <Show when={field()!.oracle}>
              <span
                class={`arena-hud-pill oracle${field()!.oracle!.confirmed ? "" : " pending"}`}
                title={`${field()!.oracle!.observable} · baseline: ${field()!.oracle!.baseline}`}
              >
                {field()!.oracle!.confirmed ? "◆ oracle" : "◇ oracle"}
              </span>
            </Show>
            <Show when={(field()!.facts?.verified ?? 0) > 0}>
              <span class="arena-facts">
                <b>{field()!.facts!.verified}</b> facts
                {field()!.facts!.contested > 0 ? ` · ${field()!.facts!.contested} contested` : ""}
              </span>
            </Show>
            <Show when={field()!.claims > 0}>
              <span class="arena-hud-pill claim">
                {field()!.claims} claim{field()!.claims === 1 ? "" : "s"}
              </span>
            </Show>
            <Show when={field()!.delivery}>
              <span
                class="arena-hud-pill"
                title={`${field()!.delivery!.delivered}/${field()!.delivery!.queued} delivered · p90 ${field()!.delivery!.p90Ms ?? "?"}ms · ${field()!.delivery!.truncated} truncated`}
              >
                ⇄ {field()!.delivery!.p50Ms ?? "?"}ms
              </span>
            </Show>
            <Show when={(field()!.openMentions ?? 0) > 0}>
              <span class="arena-hud-pill alert">
                {field()!.openMentions} ask{field()!.openMentions === 1 ? "" : "s"}
              </span>
            </Show>
            <Show when={leftCrew().length > 0}>
              <span class="arena-hud-pill bad" title={crewNames(leftCrew(), 50)}>
                {leftCrew().length} left
              </span>
            </Show>
            <Show when={field()!.closed}>
              <span class="arena-hud-pill verdict">{field()!.closed!.decision}</span>
            </Show>
            <Show when={field()!.stopReason && !field()!.closed}>
              <span class="arena-hud-pill bad">{field()!.stopReason}</span>
            </Show>
            <button
              type="button"
              class="arena-stop"
              title="Terminate the Arena for everyone"
              aria-label="Terminate the Arena for everyone"
              onClick={() => void stopArena()}
              disabled={closed() || field()!.status === "done" || sending()}
            >
              φ
            </button>
          </div>
          <div class="arena-crew-row">
            <span class="arena-crew-label">crew</span>
            <Show when={workingCrew().length > 0}>
              <span class="arena-crew-working" title={crewNames(workingCrew(), 50)}>
                {crewNames(workingCrew())}
              </span>
            </Show>
            <Show when={idleCrew().length > 0}>
              <span class="arena-crew-idle" title={crewNames(idleCrew(), 50)}>
                {crewNames(idleCrew())} idle
              </span>
            </Show>
            <Show when={workingCrew().length === 0 && idleCrew().length === 0}>
              <span class="arena-crew-idle">no live crew</span>
            </Show>
            <Show when={otherCrew().length > 0}>
              <span class="arena-crew-more">{otherCrew().length} finished</span>
            </Show>
          </div>
        </div>
      </Show>
      <div class="arena-messages" ref={listRef} onMouseDown={(event) => event.stopPropagation()}>
        <Show when={messages().length > 0} fallback={<div class="arena-empty">No messages yet. Start an arena or write to the room below.</div>}>
          <For each={messages()}>
            {(message) => <Bubble message={message} participants={participants()} onPreview={setPreview} />}
          </For>
        </Show>
      </div>

      <Show when={state()?.error || notice()}>
        <div class="arena-error arena-inline-error">{asText(state()?.error) || notice()}</div>
      </Show>

      <Show when={typing().length > 0}>
        <div class="arena-typing">{typing().join(", ")} {typing().length === 1 ? "is" : "are"} typing…</div>
      </Show>

      <Show when={field()?.status === "done"}>
        <div class="arena-closed">
          This field is closed{field()?.stopReason ? ` (${field()!.stopReason})` : ""}. All agents stopped.
          Start a new arena to get answers.
        </div>
      </Show>
      <div
        class={`arena-composer${dragging() ? " dragging" : ""}`}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          if (event.dataTransfer?.files) void addFiles(event.dataTransfer.files)
        }}
      >
        <Show when={attachments().length > 0}>
          <div class="arena-attach-row">
            <For each={attachments()}>
              {(attachment, index) => (
                <div class="arena-attach-chip">
                  <Show
                    when={attachment.mime.startsWith("image/")}
                    fallback={<span class="arena-attach-name">{attachment.name}</span>}
                  >
                    <button
                      type="button"
                      class="arena-image-button"
                      title={`Open ${attachment.name}`}
                      aria-label={`Open image ${attachment.name}`}
                      onClick={() =>
                        setPreview({
                          src: `data:${attachment.mime};base64,${attachment.data}`,
                          alt: attachment.name,
                          name: attachment.name,
                        })
                      }
                    >
                      <img
                        class="arena-attach-thumb"
                        src={`data:${attachment.mime};base64,${attachment.data}`}
                        alt={attachment.name}
                      />
                    </button>
                  </Show>
                  <button
                    class="arena-attach-x"
                    aria-label={`Remove ${attachment.name}`}
                    onClick={() => removeAttachment(index())}
                  >
                    ×
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
        <div class="arena-compose-row">
          <button
            type="button"
            class="arena-icon-btn"
            title="Attach images or files"
            aria-label="Attach images or files"
            onClick={() => fileInput?.click()}
            disabled={attachments().length >= MAX_FILES}
          >
            +
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            class="arena-hidden"
            onChange={(event) => {
              if (event.currentTarget.files) void addFiles(event.currentTarget.files)
              event.currentTarget.value = ""
            }}
          />
          <textarea
            class="arena-input"
            data-arena-composer
            rows={1}
            value={text()}
            placeholder={
              closed()
                ? 'Room stopped. Type "continue" to reopen it.'
                : 'Message the room… use "@Name" to focus someone; paste or drop files'
            }
            onInput={(event) => setText(event.currentTarget.value)}
            onPaste={(event) => {
              const files = event.clipboardData?.files
              if (files && files.length > 0) {
                event.preventDefault()
                void addFiles(files)
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
          />
          <button
            type="button"
            class="arena-icon-btn send"
            title="Send"
            aria-label="Send"
            onClick={() => void send()}
            disabled={sending() || (text().trim().length === 0 && attachments().length === 0)}
          >
            {sending() ? "…" : "↑"}
          </button>
        </div>
      </div>
      <Show when={preview()}>
        {(image) => (
          <div
            class="arena-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={image().alt || "Image preview"}
            tabindex="-1"
            ref={lightboxRef}
            onClick={(event) => {
              if (event.target === event.currentTarget) setPreview(null)
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault()
                setPreview(null)
              }
            }}
          >
            <button
              type="button"
              class="arena-lightbox-close"
              aria-label="Close image"
              onClick={() => setPreview(null)}
            >
              ×
            </button>
            <img
              class="arena-lightbox-image"
              src={image().src}
              alt={image().alt}
              onClick={(event) => event.stopPropagation()}
            />
            <Show when={image().name}>
              <div class="arena-lightbox-name">{image().name}</div>
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}

export default Plugin.define({
  setup(ctx) {
    console.log("[arena] gui setup", ctx.id)
    const bridge = ctx.main(ArenaBridge)
    const open = (session: MountedSession | undefined) => {
      if (!session) return
      ctx.layout.open(`${ctx.id}:room`, session, { background: false })
    }
    ctx.add(MenuItem, {
      menu: "session.panel",
      id: "chat",
      title: "Arena",
      icon: "speech-bubble",
      description: "Agent room",
      run: () => open(ctx.sessions.current()),
    })
    ctx.add(Panel, {
      id: "room",
      region: "side",
      width: 380,
      mobile: { title: "Arena", order: 1, kind: "tab", icon: "speech-bubble", cached: true },
      list: () => [{ id: "room", title: "Arena", tabbable: true, closable: "compact" as const }],
      render: (props: PanelProps) => <ArenaChat bridge={bridge} session={props.session} />,
    })
  },
  main(ctx) {
    ctx.log.write("info", "arena gui main ready", {})
    const entries = new Map<number, { serverID: string; sessionID: string; state: BridgeState; timer?: number; roomStamp?: string; cancelled?: boolean; abort?: AbortController }>()
    const clients = new Map<string, ReturnType<typeof OpenCode.make>>()
    let provider: IpcProvider<typeof ArenaBridge.spec> | undefined

    const clientFor = (serverID: string) => {
      let client = clients.get(serverID)
      if (!client) {
        const endpoint = ctx.serverEndpoints.get(serverID)
        if (!endpoint) throw new Error("The Arena server is not ready yet.")
        client = OpenCode.make({ baseUrl: endpoint.url, headers: endpoint.headers })
        clients.set(serverID, client)
      }
      return client
    }

    const rpcFor = (serverID: string) => clientFor(serverID).rpc(ArenaRpc)

    const setState = (window: number, state: BridgeState) => {
      const entry = entries.get(window)
      if (!entry) return
      const previous = entry.state
      // Do not stringify a room that may carry megabytes of attachments on every
      // poll; the revision fields identify a change precisely.
      const sameRoom =
        previous.room?.updatedAt === state.room?.updatedAt &&
        previous.room?.messages.length === state.room?.messages.length
      const sameField =
        previous.field?.status === state.field?.status &&
        previous.field?.stopReason === state.field?.stopReason &&
        previous.field?.posts === state.field?.posts
      if (previous.ok === state.ok && sameRoom && sameField && previous.error === state.error) return
      entry.state = state
      provider?.changed(window)
    }

    const signatures = new Map<number, string>()
    const noteSnapshot = (window: number, room: BridgeState["room"]) => {
      const summary = room
        ? `${room.closed ? "closed" : "open"} messages=${room.messages?.length ?? 0} goal=${room.goal?.status ?? "none"}`
        : "no room"
      if (signatures.get(window) === summary) return
      signatures.set(window, summary)
      ctx.log.write("info", "arena snapshot", { window, summary })
    }

    const poll = async (window: number, waitMs = 0) => {
      const entry = entries.get(window)
      if (!entry) return
      try {
        const rpc = rpcFor(entry.serverID)
        // The server holds the request until the room revision changes (or the
        // timeout), so the panel is push-driven over ordinary RPC.
        const field = (await (waitMs > 0
          ? rpc.wait({ sessionID: entry.sessionID, after: entry.roomStamp ?? "", timeoutMs: waitMs })
          : rpc.board({ sessionID: entry.sessionID })).catch(() => undefined)) as BridgeState["field"]
        const stamp = field
          ? `${field.roomUpdatedAt ?? 0}:${field.messageCount ?? 0}:${field.status}:${field.stopReason ?? ""}`
          : ""
        const needRoom = !field || !entry.state.room || entry.roomStamp !== stamp
        const room = needRoom
          ? ((await rpc.snapshot({ sessionID: entry.sessionID })) as BridgeState["room"])
          : entry.state.room
        entry.roomStamp = stamp
        noteSnapshot(window, room)
        setState(window, { ok: true, room, field })
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : JSON.stringify(error)
        ctx.log.write("warn", "arena snapshot failed", { window, message })
        setState(window, { ok: false, error: message })
      }
    }

    const pump = async (window: number) => {
      const entry = entries.get(window)
      if (!entry) return
      while (!entry.cancelled) {
        await poll(window, 15_000)
        if (entry.cancelled) return
        await new Promise((resolve) => setTimeout(resolve, 60))
      }
    }

    const EVENT_TYPES = [
      "session.created",
      "session.updated",
      "session.status",
      "session.idle",
      "session.renamed",
      "message.updated",
      "message.part.updated",
      "session.tool.called",
      "session.tool.success",
      "session.tool.failed",
      "permission.asked",
    ] as const

    /**
     * Real push: the panel listens to the server's own event stream and refetches
     * the room as soon as anything happens. The long-poll pump is only a fallback
     * for hosts whose event stream is unavailable.
     */
    const subscribe = (window: number) => {
      const entry = entries.get(window)
      if (!entry) return
      const controller = new AbortController()
      entry.abort = controller
      void (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const client = clientFor(entry.serverID)
          for await (const event of client.event.subscribe({ signal: controller.signal, types: [...EVENT_TYPES] } as never)) {
            if (entry.cancelled) return
            if (timer) continue
            timer = setTimeout(() => {
              timer = undefined
              void poll(window)
            }, 150)
            void event
          }
        } catch {
          // Event stream unavailable on this host: fall back to the long poll.
        }
        if (entry.cancelled) return
        void pump(window)
      })()
    }

    provider = ctx.provide(ArenaBridge, {
      state(window: number) {
        return entries.get(window)?.state ?? { ok: false, error: "Open the Arena tab to connect." }
      },
      async watch(input, caller) {
        const request = input as unknown as WatchRequest
        // The caller context ends with this request; keep the plain window id
        // so the loop does not read a disposed object on every tick.
        const window = caller.window
        const old = entries.get(window)
        if (old) old.cancelled = true
        const entry: { serverID: string; sessionID: string; state: BridgeState; cancelled?: boolean; timer?: number; roomStamp?: string } = {
          serverID: request.serverID,
          sessionID: request.sessionID,
          state: { ok: false, error: "Connecting to the room..." },
        }
        entries.set(window, entry)
        subscribe(window)
        await poll(window)
        return entry.state
      },
      async send(input, caller) {
        const request = input as unknown as SendRequest
        const entry = entries.get(caller.window)
        if (!entry) throw new Error("Open the Arena tab before sending.")
        const rpc = rpcFor(entry.serverID)
        try {
          await rpc.send({
            sessionID: request.sessionID,
            text: request.text,
            to: request.to ?? "all",
            private: request.private ?? false,
            attachments: request.attachments ?? [],
          })
        } catch (error) {
          const message = asText(error, "")
          throw new Error(message && message !== "[object Object]" ? message : "The room rejected the message. Open the Arena tab and try again.")
        }
        await poll(caller.window)
        return { ok: true }
      },
    })

    ctx.onCleanup(() => {
      for (const entry of entries.values()) {
        entry.cancelled = true
        entry.abort?.abort()
        if (entry.timer) clearInterval(entry.timer)
      }
      provider?.dispose()
    })
  },
})
