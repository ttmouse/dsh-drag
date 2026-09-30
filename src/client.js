/**
 * dsh-drag — browser half.
 *
 * Drag a conversation row from the sidebar's session list into the chat
 * transcript area: a floating hint follows the pointer and, on drop, the
 * session reference (`@[label](dsh-session:…)` mention) is inserted into the
 * target session's composer draft as a reference chip.
 *
 * Why this shape:
 * - The sidebar rows are native HTML5 drag sources already: ui-workspace's
 *   SessionNodeItem puts the raw session id on the payload
 *   (`dataTransfer.setData('text/plain', node.id)`, verified in 0.1.5-rc.2).
 * - The drop side is this plugin's document-level dragover/drop pair. Dropping
 *   back onto the sidebar (any `[data-row-key]` target) is deliberately NOT
 *   prevented so the official reorder behavior keeps working.
 * - The insertion goes through `conversation.input.for(actx).insertReference`,
 *   the same span-CAS'd chip path the composer's own pick flow uses; the span
 *   (caret + draftRev) is captured at drop time via the session scope's
 *   `inputActions.captureInsertion()`.
 *
 * Row identity: dragstart records the payload only when its target carries
 * `data-row-key="session:<sessionId>"` — workspace rows (`workspace:<id>`)
 * and every other drag source stay inert.
 */

/** Locale namespace owned by this plugin. */
const NS = 'dshDrag'

/** Dictionary key set (the source of truth for both locales). */
const KEYS = ['hint.reference', 'info.self', 'error.insert']

const DICTIONARIES = {
  zh: {
    'hint.reference': '松开以引用会话「{title}」',
    'info.self': '当前会话不需要引用自己',
    'error.insert': '会话引用插入失败',
  },
  en: {
    'hint.reference': 'Drop to reference “{title}”',
    'info.self': 'The current session does not need to reference itself',
    'error.insert': 'Failed to insert the session reference',
  },
}

/** Canonical `dsh-session:` URI (host form: base64url(JSON.stringify(id))). */
function encodeSessionUri(sessionId) {
  const bytes = new TextEncoder().encode(JSON.stringify(sessionId))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `dsh-session:${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
}

/** Escape a mention label: backslash and closing bracket. */
function escapeLabel(label) {
  return label.replace(/[\\\]]/gu, (match) => `\\${match}`)
}

/** Host-neutral Markdown mention carrying the canonical URI. */
function formatSessionMention(sessionId, label) {
  return `@[${escapeLabel(label ?? sessionId)}](${encodeSessionUri(sessionId)})`
}

/** True when the payload is a bare session id (what sidebar rows put there). */
function isPlausibleSessionId(text) {
  return typeof text === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(text)
}

/** Read `data-row-key` off the event target's ancestor row, if any. */
function rowKeyOf(target) {
  return target && typeof target.closest === 'function'
    ? target.closest('[data-row-key]')?.getAttribute('data-row-key') ?? null
    : null
}

/**
 * The document-level drop surface: tracks the active sidebar session drag,
 * shows a floating hint while over the chat area, and inserts the reference
 * on drop. Pure DOM + callbacks so tests can drive it without a browser.
 * @param deps - doc, sessions, t, currentSessionId, inputActions,
 *   insertSessionReference, notify, onHint.
 * @returns disposer removing every listener.
 */
function createDropSurface(deps) {
  const { doc, sessions, t, currentSessionId, inputActions, insertSessionReference, notify, onHint } = deps

  /** The drag in flight: `{ sessionId, title } | null`. */
  let dragging = null
  /** A drag that ended can never drop (dragend always precedes a later drop). */
  let ended = true

  const hideHint = () => { onHint(null) }

  const onDragStart = (event) => {
    const rowKey = rowKeyOf(event.target)
    const sessionId = rowKey !== null && rowKey.startsWith('session:')
      ? rowKey.slice('session:'.length)
      : null
    if (sessionId === null || !isPlausibleSessionId(sessionId)) return
    const summary = sessions.list.getSnapshot().byId[sessionId]
    if (!summary) return
    dragging = { sessionId, title: summary.displayTitle ?? summary.title ?? sessionId }
    ended = false
  }

  const overSidebar = (event) => rowKeyOf(event.target) !== null

  const onDragOver = (event) => {
    if (dragging === null || ended) return
    // The sidebar keeps its own reorder handling: never touch those events.
    if (overSidebar(event)) {
      hideHint()
      return
    }
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    onHint({ text: t('hint.reference', { title: dragging.title }), x: event.clientX + 14, y: event.clientY + 18 })
  }

  const onDrop = (event) => {
    if (dragging === null || ended) return
    if (overSidebar(event)) return
    event.preventDefault()
    hideHint()
    const { sessionId, title } = dragging
    ended = true
    dragging = null
    if (sessionId === currentSessionId) {
      notify('info', t('info.self'))
      return
    }
    const mention = formatSessionMention(sessionId, title)
    const span = inputActions.captureInsertion()
    const inserted = insertSessionReference({
      source: 'reference',
      ref: mention,
      label: title,
      appearance: 'session',
      clipboardText: mention,
    }, span)
    if (!inserted) notify('error', t('error.insert'))
  }

  const onDragEnd = () => {
    ended = true
    dragging = null
    hideHint()
  }

  doc.addEventListener('dragstart', onDragStart)
  doc.addEventListener('dragover', onDragOver)
  doc.addEventListener('drop', onDrop)
  doc.addEventListener('dragend', onDragEnd)

  return () => {
    doc.removeEventListener('dragstart', onDragStart)
    doc.removeEventListener('dragover', onDragOver)
    doc.removeEventListener('drop', onDrop)
    doc.removeEventListener('dragend', onDragEnd)
  }
}

/**
 * Required services (cordis fiber inject): the slot registry, the sessions
 * controller (list snapshot + scope resolution), the conversation service
 * (per-session input facade), and the locale service.
 */
const pluginInject = ['slots', 'sessions', 'conversation', 'locale']

/**
 * Browser plugin body: register dictionaries, then wire the dock entry whose
 * inject share closes over the per-session input facade.
 * @param ctx - client root context.
 */
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'dsh-drag: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.inject(['slots', 'sessions', 'conversation'], (scope) => {
    const { slots, sessions, conversation } = scope

    slots.inject('conversation.input.dock', () => slots.register({
      name: 'conversation.input.dock',
      id: 'dsh-drag',
      order: 40,
      registrant: 'dsh-drag',
      locale: NS,
      inject: (sessionId) => {
        const actx = sessions.scope(sessionId)
        if (actx === undefined) {
          return {
            targetSessionId: sessionId,
            sessions,
            t,
            insertSessionReference: () => false,
            notify: () => {},
          }
        }
        const input = conversation.input.for(actx)
        return {
          targetSessionId: sessionId,
          sessions,
          t,
          insertSessionReference: (reference, span) => input.insertReference(reference, span),
          notify: (level, text) => input.notify(level, text),
        }
      },
    }, DragDock))
  })
}

/**
 * The dock entry renders nothing: the drag surface is document-level and
 * mounted once from apply(). The registration exists to carry the per-session
 * insertion face (inject share) the surface closes over — dropping while a
 * session's composer is open targets that session's input machine.
 */
function DragDock() {
  return null
}

/** Internals exposed for tests and debugging. */
const __internals = {
  createDropSurface,
  formatSessionMention,
  encodeSessionUri,
}
