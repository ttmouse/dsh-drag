/**
 * dsh-drag current-Session resolution test.
 *
 * The bug this file exists for: 0.2.0-rc.2 removed `SessionListState.current`
 * (that state is now `{ ids, byId, phase, projectionsBySession }`), while
 * `apply()` resolved the drop target with `list.getSnapshot().current`. The
 * lookup answered `undefined` forever, `resolveFace()` returned null, and the
 * whole drop became a silent no-op — the drag armed, `dragover` accepted and
 * showed the copy cursor, and then nothing was inserted and not even the
 * failure notice appeared (notify rides the same null path).
 *
 * `test/apply-wiring.mjs` cannot catch that class of drift: it feeds the plugin
 * a list snapshot shaped the way the plugin itself assumes. This file instead
 * pins the two SHAPES the plugin must serve:
 * - 0.2.0-rc.2+: no `current`; the composer's Session is the row the main view
 *   retains (`retainedBy.mainView > 0`) — the shell's own predicate;
 * - up to 0.1.5-rc.x: `current` published directly on the snapshot.
 *
 * Run: node test/session-resolution.mjs [bundle.js]
 */
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const BUNDLE = process.argv[2] ?? join(here, '..', 'lib', 'client.js')

/** Load the shipped bundle and return the module its loader factory produced. */
async function loadBundle() {
  let captured = null
  globalThis.window = { __ModuleLoader__: { load: (definition) => { captured = definition } } }
  await import(pathToFileURL(BUNDLE).href)
  assert.ok(captured !== null, 'the bundle must call window.__ModuleLoader__.load')
  return captured.factory(() => { throw new Error('the browser half requires no modules') })
}

/** Listener-recording document stub (no createElement: the surface draws nothing). */
function fakeDoc() {
  const listeners = new Map()
  const key = (type, capture) => `${type}${capture === true ? ':capture' : ''}`
  return {
    addEventListener(type, fn, capture) {
      const id = key(type, capture)
      listeners.set(id, [...(listeners.get(id) ?? []), fn])
    },
    removeEventListener(type, fn, capture) {
      const list = listeners.get(key(type, capture)) ?? []
      const at = list.indexOf(fn)
      if (at >= 0) list.splice(at, 1)
    },
    emit(type, event, capture = false) {
      for (const fn of [...(listeners.get(key(type, capture)) ?? [])]) fn(event)
    },
  }
}

/** A row the main view retains, as 0.2.0-rc.2 projects it. */
const retained = (mainView) => ({ retainedBy: { mainView } })

/**
 * The two live host list shapes, plus the degenerate one where no composer is
 * on stage at all.
 */
const LISTS = {
  // 0.2.0-rc.2: no `current`; ownership carries the answer.
  v020: {
    ids: ['session-a', 'session-shown', 'session-b'],
    byId: {
      'session-a': { id: 'session-a', displayTitle: 'A 会话', ...retained(0) },
      'session-shown': { id: 'session-shown', displayTitle: 'Shown', ...retained(1) },
      'session-b': { id: 'session-b', displayTitle: 'B 会话', ...retained(0) },
    },
    phase: 'ready',
    projectionsBySession: {},
  },
  // up to 0.1.5-rc.x: `current`, and rows that carry no ownership at all.
  legacy: {
    current: 'session-shown',
    ids: ['session-a', 'session-shown'],
    byId: {
      'session-a': { id: 'session-a', displayTitle: 'A 会话' },
      'session-shown': { id: 'session-shown', displayTitle: 'Shown' },
    },
    phase: 'ready',
  },
  // Nothing on stage: no `current`, nothing retained by the main view.
  empty: {
    ids: [],
    byId: {},
    phase: 'ready',
    projectionsBySession: {},
  },
  // A draggable row exists, but no Session is shown in the main view.
  noComposer: {
    ids: ['session-a'],
    byId: {
      'session-a': { id: 'session-a', displayTitle: 'A 会话', ...retained(0) },
    },
    phase: 'ready',
    projectionsBySession: {},
  },
}

const chatTarget = { closest: () => null }

/** A drop target that answers `closest` for exactly the listed selectors. */
const targetWith = (map) => ({ closest: (selector) => (selector in map ? map[selector] : null) })
/** A row inside the sidebar tree: the shell's own tree, no conversation column. */
const sidebarTarget = targetWith({ '[role="tree"]': {} })
/** The trajectory view: a `role="tree"` JSON tree mounted INSIDE the chat column. */
const trajectoryTarget = targetWith({ '[data-conversation-content]': {}, '[role="tree"]': {} })

function dragStartEvent(payload) {
  return {
    target: chatTarget,
    dataTransfer: { effectAllowed: 'move', getData: (type) => (type === 'text/plain' ? payload : '') },
  }
}

function dragOverEvent(target) {
  return {
    target,
    dataTransfer: { dropEffect: 'none' },
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() {},
  }
}

function dropEvent(target = chatTarget) {
  return {
    target,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() {},
  }
}

/** Boot apply() against one host list shape; returns what the insert path saw. */
function boot(list) {
  const doc = fakeDoc()
  globalThis.document = doc

  const inserted = []
  const notices = []
  const actxOf = (id) => ({ tag: id })
  const scopes = new Map(Object.keys(list.byId).map((id) => [id, actxOf(id)]))
  const shell = {
    caretSpan: () => ({ start: 3, end: 3 }),
    snapshot: { draft: '', draftRev: 9 },
    insertReference: (reference, span) => { inserted.push({ reference, span }); return true },
    notify: (level, text) => { notices.push({ level, text }) },
  }

  const sessions = {
    list: { getSnapshot: () => list },
    scope: (id) => scopes.get(id),
  }
  const conversation = { input: { for: () => shell } }

  const ctx = {
    effect: (fn) => fn(),
    locale: { register: () => () => {}, bind: (ns) => (key) => `${ns}.${key}` },
    inject: (deps, callback) => callback({
      effect: (fn) => fn(),
      slots: { inject: (name, produce) => produce(), register: () => () => {} },
      sessions,
      conversation,
    }),
  }

  return { doc, ctx, inserted, notices, scopeTags: () => [...scopes.keys()] }
}

async function main() {
  const plugin = await loadBundle()

  // ── 0.2.0-rc.2 shape: the retained row is the drop target ──
  {
    const { doc, ctx, inserted, notices } = boot(LISTS.v020)
    plugin.apply(ctx)
    doc.emit('dragstart', dragStartEvent('session-a'))
    doc.emit('drop', dropEvent(), true)
    assert.equal(inserted.length, 1, 'a 0.2.0-rc.2 list (no `current`) must still insert')
    assert.equal(inserted[0].reference.source, 'reference')
    assert.match(inserted[0].reference.ref, /dsh-session:/u)
    assert.equal(inserted[0].reference.label, 'A 会话', 'the dragged row supplies the label')
    assert.deepEqual(inserted[0].span, { start: 3, end: 3, draftRev: 9 }, 'the span stays caret + draftRev')
    assert.deepEqual(notices, [], 'a successful insert reports nothing')
  }

  // ── the retained row must win over earlier rows in the same snapshot ──
  {
    const { doc, ctx, inserted } = boot(LISTS.v020)
    plugin.apply(ctx)
    // session-shown is the retained one; dragging it is a self-reference.
    doc.emit('dragstart', dragStartEvent('session-shown'))
    const self = dropEvent()
    doc.emit('drop', self, true)
    assert.deepEqual(inserted, [], 'the main-view Session must not be referenced by itself')
  }

  // ── legacy shape (0.1.5-rc.x) keeps working ──
  {
    const { doc, ctx, inserted } = boot(LISTS.legacy)
    plugin.apply(ctx)
    doc.emit('dragstart', dragStartEvent('session-a'))
    doc.emit('drop', dropEvent(), true)
    assert.equal(inserted.length, 1, 'a host that still publishes `current` must keep inserting')
  }

  // ── the chat column accepts even over a nested `role="tree"` ──
  {
    const { doc, ctx, inserted } = boot(LISTS.v020)
    plugin.apply(ctx)
    doc.emit('dragstart', dragStartEvent('session-a'))
    const over = dragOverEvent(trajectoryTarget)
    doc.emit('dragover', over, true)
    assert.equal(
      over.defaultPrevented,
      true,
      'the trajectory view is a role="tree" inside the chat column, not the sidebar: the drop must be accepted',
    )
    doc.emit('drop', dropEvent(trajectoryTarget), true)
    assert.equal(inserted.length, 1, 'and it must insert')
  }

  // ── the sidebar tree keeps its own reorder handling ──
  {
    const { doc, ctx, inserted } = boot(LISTS.v020)
    plugin.apply(ctx)
    doc.emit('dragstart', dragStartEvent('session-a'))
    const over = dragOverEvent(sidebarTarget)
    doc.emit('dragover', over, true)
    assert.equal(over.defaultPrevented, false, 'a sidebar tree must keep its own dragover handling')
    doc.emit('drop', dropEvent(sidebarTarget), true)
    assert.deepEqual(inserted, [], 'a sidebar drop must not insert')
  }

  // ── a draggable row but no composer on stage: inert, and never silent ──
  {
    const warnings = []
    const original = console.warn
    console.warn = (...args) => warnings.push(args.join(' '))
    try {
      const { doc, ctx, inserted, notices } = boot(LISTS.noComposer)
      plugin.apply(ctx)
      doc.emit('dragstart', dragStartEvent('session-a'))
      doc.emit('drop', dropEvent(), true)
      assert.deepEqual(inserted, [], 'with no main-view Session there is nothing to insert into')
      assert.deepEqual(notices, [], 'and no in-app notice either — there is no composer to report to')
    } finally {
      console.warn = original
    }
    assert.equal(warnings.length, 1, 'a face that cannot resolve must leave a console trace')
    assert.match(warnings[0], /dsh-drag/u, 'the trace names the plugin so a silent no-op is diagnosable')
  }

  // ── a session list with nothing on stage at all: no arm, no crash ──
  {
    const { doc, ctx, inserted, notices } = boot(LISTS.empty)
    plugin.apply(ctx)
    doc.emit('dragstart', dragStartEvent('session-a'))
    doc.emit('drop', dropEvent(), true)
    assert.deepEqual(inserted, [], 'an empty list has nothing to drag and nothing to insert into')
    assert.deepEqual(notices, [])
  }

  console.log(`dsh-drag Session resolution: passed (${BUNDLE})`)
}

await main()
