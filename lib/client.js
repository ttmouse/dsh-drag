// Browser half of dsh-drag. Loaded through the web plugin loader
// (window.__ModuleLoader__); built by scripts/build.mjs from src/client.js.
window.__ModuleLoader__.load({ id: 'dsh-drag', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  /**
   * dsh-drag — browser half.
   *
   * Drag a conversation row out of the sidebar's session list and drop it over
   * the chat area: the session reference (`@[label](dsh-session:…)` mention) is
   * inserted into the open composer's draft as a reference chip.
   *
   * Feedback is the browser's own: the native drag image of the row follows the
   * pointer and the accepted drop area shows the `copy` cursor badge. This plugin
   * deliberately draws no overlay — an earlier revision added a floating label of
   * its own, which just doubled the row's title next to the cursor.
   *
   * Why this shape (verified against the 0.1.5-rc.2 bundles):
   * - The sidebar rows are native HTML5 drag sources already: ui-workspace's
   *   SessionNodeItem sets `dataTransfer.setData('text/plain', node.id)` — the
   *   raw session id — on dragstart.
   * - The drop side is this plugin's document-level dragover/drop pair, taken in
   *   the capture phase so the composer's own Lexical drop path never pastes the
   *   bare session id. Anything inside the sidebar tree (`[role="tree"]`) is left
   *   untouched so the official row reordering keeps working.
   * - The insertion goes through the facade the composer's own pick flow uses:
   *   `conversation.input.for(actx).insertReference(reference, span, …)`, with the
   *   span built from `caretSpan()` (detect coordinates) + `snapshot.draftRev`
   *   (the input machine's CAS revision). There is no `captureInsertion()`.
   * - The target composer is resolved at drop time from the session list's
   *   `current` id, so this plugin needs no slot to render anything.
   *
   * Row identity: the `text/plain` payload (a `data-row-key="session:<id>"`
   * attribute is still honored for forward compatibility). Workspace rows, file
   * drags, and every other source stay inert.
   */

  /** Locale namespace owned by this plugin. */
  const NS = 'dshDrag'

  const DICTIONARIES = {
    zh: {
      'info.self': '当前会话不需要引用自己',
      'error.insert': '会话引用插入失败',
    },
    en: {
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
   * The document-level drop surface: tracks the active sidebar session drag and
   * inserts the reference on drop, leaving every visual to the browser's own drag
   * image and cursor badge. Pure DOM + callbacks so tests can drive it without a
   * browser.
   * @param deps - doc, sessions, t, currentSessionId, inputActions,
   *   insertSessionReference, notify.
   * @returns disposer removing every listener.
   */
  function createDropSurface(deps) {
    const { doc, sessions, t, currentSessionId, inputActions, insertSessionReference, notify } = deps
    /** currentSessionId may be a getter (production) or a plain id (tests). */
    const currentId = () => (typeof currentSessionId === 'function' ? currentSessionId() : currentSessionId)

    /** The drag in flight: `{ sessionId, title } | null`. */
    let dragging = null
    /** A drag that ended can never drop (dragend always precedes a later drop). */
    let ended = true

    const onDragStart = (event) => {
      // Every dragstart opens a fresh gesture: a previous drag whose `dragend`
      // never reached the document — the sidebar source row unmounts mid-reorder,
      // and a detached node's events stop bubbling — must not leave the surface
      // armed, or the next drag of anything would insert a chip.
      dragging = null
      ended = true
      // Identity sources, first match wins: the row's `data-row-key` attribute
      // ("session:<id>", kept for forward compatibility) or — what the shipped
      // 0.1.5-rc.2 rows actually set — the `text/plain` payload, which ui-
      // workspace's SessionNodeItem fills with the raw session id.
      const rowKey = rowKeyOf(event.target)
      const transfer = event.dataTransfer
      const payload = typeof transfer?.getData === 'function' ? transfer.getData('text/plain') ?? '' : ''
      const sessionId = rowKey !== null && rowKey.startsWith('session:')
        ? rowKey.slice('session:'.length)
        : payload
      if (!isPlausibleSessionId(sessionId)) return
      const summary = sessions.list.getSnapshot().byId[sessionId]
      if (!summary) return
      dragging = { sessionId, title: summary.displayTitle ?? summary.title ?? sessionId }
      ended = false
      // The row's own dragstart declares `move` (that drag is the official
      // reorder gesture). A `copy` dropEffect outside effectAllowed is not a legal
      // pair — Chrome tolerates it, stricter engines simply refuse the drop — so
      // widen the allowance here, in the same dragstart, after the row's handler
      // has put the payload on.
      if (transfer) transfer.effectAllowed = 'copyMove'
    }

    /** The sidebar region: any row the shell owns. Real rows carry no
     *  data-row-key, so the drag source element itself is the marker. */
    const overSidebar = (event) => {
      if (rowKeyOf(event.target) !== null) return true
      const closest = event.target?.closest
      return typeof closest === 'function' && event.target.closest('[role="tree"]') !== null
    }

    const onDragOver = (event) => {
      if (dragging === null || ended) return
      // The sidebar keeps its own reorder handling: never touch those events.
      if (overSidebar(event)) return
      // Accepting the drop is the whole signal: the pointer picks up the copy
      // badge, which is the only feedback this plugin adds. The gesture is taken
      // whole — see the capture-phase note at the listener pair below.
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }

    const onDrop = (event) => {
      if (dragging === null || ended) return
      if (overSidebar(event)) return
      event.preventDefault()
      event.stopPropagation()
      const { sessionId, title } = dragging
      ended = true
      dragging = null
      if (sessionId === currentId()) {
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
    }

    // `dragover`/`drop` ride the capture phase. The composer is a Lexical editor
    // whose own drop listener (on the editor root, a descendant) would paste the
    // `text/plain` payload — the bare session id — into the draft before any
    // bubble-phase listener runs, so dropping right on the input would leave the
    // chip preceded by raw id text. Capture reaches document first, and the
    // accept path stops propagation, so the chip is the only insertion.
    // `dragstart`/`dragend` stay on bubble: the sidebar row's own handler sets the
    // payload first, and this listener reads it.
    doc.addEventListener('dragstart', onDragStart)
    doc.addEventListener('dragover', onDragOver, true)
    doc.addEventListener('drop', onDrop, true)
    doc.addEventListener('dragend', onDragEnd)

    return () => {
      doc.removeEventListener('dragstart', onDragStart)
      doc.removeEventListener('dragover', onDragOver, true)
      doc.removeEventListener('drop', onDrop, true)
      doc.removeEventListener('dragend', onDragEnd)
    }
  }

  /**
   * Required services (cordis fiber inject): the sessions controller (list
   * snapshot + scope resolution), the conversation service (per-session input
   * facade), and the locale service.
   */
  const pluginInject = ['slots', 'sessions', 'conversation', 'locale']

  /**
   * Browser plugin body: register the dictionaries on the root fiber, then mount
   * the document-level drop surface inside the service-gated inject scope.
   * @param ctx - client root context.
   */
  function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'dsh-drag: dictionaries')
    const t = ctx.locale.bind(NS)

    ctx.inject(['slots', 'sessions', 'conversation'], (scope) => {
      const { slots, sessions, conversation } = scope

      /** Insertion face resolved at drop time against the CURRENT session: the
       *  composer the user is looking at is the one the chip must land in. Answers
       *  null rather than throwing — a drop handler has nowhere to report to, and
       *  `conversation.input.for` throws for a session that resolves no binding. */
      const resolveFace = () => {
        try {
          const current = sessions.list.getSnapshot().current
          if (current === undefined) return null
          const actx = sessions.scope(current)
          if (actx === undefined) return null
          const input = conversation.input.for(actx)
          const span = () => {
            // The shell facade answers the live caret (detect coordinates) and the
            // hot InputState (draftRev for the span CAS). A collapsed span at the
            // caret is what insertReference replaces with the chip.
            const caret = typeof input.caretSpan === 'function' ? input.caretSpan() : { start: 0, end: 0 }
            const rev = (input.snapshot ?? input.state?.getSnapshot())?.draftRev ?? 0
            return { start: caret.start, end: caret.end, draftRev: rev }
          }
          return {
            insertSessionReference: (reference, sp) => input.insertReference(reference, sp),
            notify: (level, text) => input.notify(level, text),
            captureInsertion: span,
          }
        } catch {
          return null
        }
      }

      // The one document-level drag surface. `scope.effect`, not `ctx.effect`:
      // inject() is plugin({inject, apply: callback}), so this callback re-runs
      // whenever those services are re-provided (a hot-reloaded conversation or
      // session-controller bundle). Tying the surface to the injected scope
      // disposes the old listener pair before the new one mounts; tying it to the
      // root fiber would mount a second surface and insert twice per drop.
      // The inert stub keeps Node test harnesses able to apply() without a DOM.
      scope.effect(() => createDropSurface({
        doc: typeof document === 'object' && document !== null ? document : { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} },
        sessions,
        t,
        currentSessionId: () => sessions.list.getSnapshot().current,
        inputActions: { captureInsertion: () => resolveFace()?.captureInsertion() ?? { start: 0, end: 0, draftRev: 0 } },
        insertSessionReference: (reference, sp) => resolveFace()?.insertSessionReference(reference, sp) ?? false,
        notify: (level, text) => resolveFace()?.notify(level, text),
      }), 'dsh-drag: drop surface')

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
   * The dock entry renders nothing, and nothing consumes its inject share: the
   * surface resolves the current composer itself at drop time (resolveFace). It is
   * a leftover of the earlier design and can be deleted outright — it only costs
   * one null seat in the composer dock.
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
  module.exports = { inject: pluginInject, apply, DragDock, __internals };
  return module.exports
} })
