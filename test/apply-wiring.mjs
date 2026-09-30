/**
 * dsh-drag apply()-wiring test.
 *
 * The bug this file exists for: 0.1.0 shipped a browser half whose `apply()`
 * never mounted the drop surface — the module exported a correct
 * `createDropSurface` and the older tests drove it directly, so every test
 * passed while the installed plugin did nothing at all. This test only ever
 * goes through `apply(ctx)`: it installs a fake document, calls the plugin
 * body, and then drives a whole drag gesture at what the plugin itself wired.
 *
 * It also pins the two host contracts the insertion depends on, so a drift in
 * either fails here instead of silently in the browser:
 * - the dragged session id arrives on the `text/plain` payload (ui-workspace's
 *   SessionNodeItem), not on a `data-row-key` attribute;
 * - the chip span is the live caret (`caretSpan()`, detect coordinates) stamped
 *   with the input machine's revision (`snapshot.draftRev`).
 *
 * Run: node test/apply-wiring.mjs [bundle.js]
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const BUNDLE = process.argv[2] ?? join(here, '..', 'lib', 'client.js')
const HINT_ID = 'dsh-drag-hint'

/** Load the shipped bundle and return the module its loader factory produced. */
async function loadBundle() {
  let captured = null
  globalThis.window = { __ModuleLoader__: { load: (definition) => { captured = definition } } }
  await import(pathToFileURL(BUNDLE).href)
  assert.ok(captured !== null, 'the bundle must call window.__ModuleLoader__.load')
  return captured.factory(() => { throw new Error('the browser half requires no modules') })
}

/** One fake element: enough surface for the hint layer. */
function fakeElement(doc, tag) {
  return {
    tagName: tag,
    id: '',
    style: {},
    dataset: {},
    attributes: {},
    textContent: '',
    removed: false,
    setAttribute(name, value) { this.attributes[name] = value },
    getAttribute(name) { return this.attributes[name] ?? null },
    remove() {
      this.removed = true
      if (this.id !== '' && doc.byId.get(this.id) === this) doc.byId.delete(this.id)
    },
  }
}

/**
 * A document stub: records listeners per type (so a missing mount is visible),
 * keeps appended elements addressable by id (the hint layer's own lookup), and
 * dispatches events to whatever the plugin installed.
 */
function fakeDoc() {
  const listeners = new Map()
  const byId = new Map()
  const doc = {
    byId,
    createElement: (tag) => fakeElement(doc, tag),
    getElementById: (id) => byId.get(id) ?? null,
    body: {
      appendChild(el) {
        if (el.id !== '') byId.set(el.id, el)
      },
    },
    addEventListener(type, fn) {
      const list = listeners.get(type) ?? []
      list.push(fn)
      listeners.set(type, list)
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) ?? []
      const at = list.indexOf(fn)
      if (at >= 0) list.splice(at, 1)
    },
    emit(type, event) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event)
    },
    count: () => [...listeners.values()].reduce((total, list) => total + list.length, 0),
  }
  return doc
}

/** An event target outside the sidebar. */
const chatTarget = { closest: () => null }

/** A session row in the native sidebar tree. */
const sidebarTarget = { closest: (selector) => (selector === '[role="tree"]' ? {} : null) }

function dragStartEvent(payload) {
  return { target: chatTarget, dataTransfer: { effectAllowed: '', getData: (type) => (type === 'text/plain' ? payload : '') } }
}

function dragOverEvent(target, clientX = 400, clientY = 250) {
  return {
    target,
    clientX,
    clientY,
    dataTransfer: { dropEffect: 'none' },
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
  }
}

function dropEvent(target) {
  return { target, clientX: 400, clientY: 250, defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
}

/** The host's canonical mention, encoded with Node's own base64url encoder. */
function hostMention(sessionId, label) {
  const escaped = (label ?? sessionId).replace(/[\\\]]/gu, (match) => `\\${match}`)
  return `@[${escaped}](dsh-session:${Buffer.from(JSON.stringify(sessionId), 'utf8').toString('base64url')})`
}

/**
 * Boot the plugin against a fake host: returns the fake document, everything
 * the insertion path observed, and the fiber disposers apply() registered.
 */
function boot({ currentSessionId = 'session-current', noSession = false } = {}) {
  const doc = fakeDoc()
  globalThis.document = doc
  /** What `sessions.list.current` answers: an id, or nothing on stage at all. */
  const current = noSession ? undefined : currentSessionId

  const inserted = []
  const notices = []
  const dictionaries = []
  const registered = []
  const disposers = []

  const shell = {
    caretSpan: () => ({ start: 7, end: 7 }),
    snapshot: { draft: '', draftRev: 12 },
    insertReference: (reference, span) => { inserted.push({ reference, span }); return true },
    notify: (level, text) => { notices.push({ level, text }) },
  }
  const actx = { tag: 'session-current' }
  const sessions = {
    list: {
      getSnapshot: () => ({
        current,
        byId: {
          'session-a': { id: 'session-a', displayTitle: 'A 会话' },
          'session-current': { id: 'session-current', displayTitle: 'Current' },
        },
      }),
    },
    scope: (id) => (current !== undefined && id === current ? actx : undefined),
  }
  const conversation = {
    input: {
      for: (scope) => {
        assert.equal(scope, actx, 'the insertion must resolve the CURRENT session scope')
        return shell
      },
    },
  }

  const ctx = {
    effect(fn, label) {
      assert.equal(typeof label, 'string')
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    locale: {
      register: (ns, dicts) => { dictionaries.push({ ns, dicts }); return () => {} },
      bind: (ns) => (key, params) => (params === undefined ? `${ns}.${key}` : `${ns}.${key}(${params.title})`),
    },
    inject(deps, callback) {
      assert.deepEqual(deps, ['slots', 'sessions', 'conversation'])
      callback({
        slots: {
          inject: (name, produce) => { registered.push(name); produce() },
          register: (spec, component) => { registered.push({ spec, component }); return () => {} },
        },
        sessions,
        conversation,
      })
    },
  }

  return { doc, ctx, inserted, notices, dictionaries, registered, disposers }
}

async function main() {
  const plugin = await loadBundle()
  const { doc, ctx, inserted, notices, dictionaries, registered, disposers } = boot()

  // ── apply() itself must mount the surface; nothing else is exported to do it ──
  plugin.apply(ctx)

  assert.deepEqual(registered[0], 'conversation.input.dock', 'the dock entry stays registered')
  assert.equal(dictionaries.length, 1)
  assert.deepEqual(Object.keys(dictionaries[0].dicts).sort(), ['en', 'zh'])
  assert.equal(
    doc.count(),
    4,
    'apply() must install the four document drag listeners (this is what silently did not happen in 0.1.0)',
  )
  // ── one whole gesture, driven only at the document listeners apply() installed ──
  doc.emit('dragstart', dragStartEvent('session-a'))
  const over = dragOverEvent(chatTarget)
  doc.emit('dragover', over)
  assert.equal(over.defaultPrevented, true, 'dragover over the chat area must allow the drop')
  assert.equal(over.dataTransfer.dropEffect, 'copy')

  const hint = doc.getElementById(HINT_ID)
  assert.ok(hint !== null && hint.removed === false, 'the hint element must be mounted while dragging')
  assert.equal(hint.textContent, 'dshDrag.hint.reference(A 会话)')
  assert.equal(hint.style.left, '414px')
  assert.equal(hint.style.top, '268px')

  const drop = dropEvent(chatTarget)
  doc.emit('drop', drop)
  assert.equal(drop.defaultPrevented, true)
  assert.equal(doc.getElementById(HINT_ID), null, 'the hint clears on drop')
  assert.deepEqual(notices, [])
  assert.deepEqual(inserted, [{
    reference: {
      source: 'reference',
      ref: hostMention('session-a', 'A 会话'),
      label: 'A 会话',
      appearance: 'session',
      clipboardText: hostMention('session-a', 'A 会话'),
    },
    span: { start: 7, end: 7, draftRev: 12 },
  }], 'the chip rides caretSpan() + snapshot.draftRev')

  // ── the sidebar keeps its own reorder handling ──
  doc.emit('dragstart', dragStartEvent('session-a'))
  const overSidebar = dragOverEvent(sidebarTarget)
  doc.emit('dragover', overSidebar)
  assert.equal(overSidebar.defaultPrevented, false, 'the sidebar must keep its own dragover handling')
  assert.equal(doc.getElementById(HINT_ID), null, 'no chat hint over the sidebar')
  const dropSidebar = dropEvent(sidebarTarget)
  doc.emit('drop', dropSidebar)
  assert.equal(dropSidebar.defaultPrevented, false)
  assert.equal(inserted.length, 1, 'a sidebar drop must not insert')

  // ── workspace rows and other payloads stay inert ──
  for (const payload of ['workspace:ws-1', '/Users/douba/notes.md', '', 'session-gone']) {
    doc.emit('dragstart', dragStartEvent(payload))
    const inertOver = dragOverEvent(chatTarget)
    doc.emit('dragover', inertOver)
    assert.equal(inertOver.defaultPrevented, false, `payload ${JSON.stringify(payload)} must not arm the drop`)
    doc.emit('drop', dropEvent(chatTarget))
    assert.equal(inserted.length, 1, `payload ${JSON.stringify(payload)} must not insert`)
  }

  // ── a drag that ends is over: no drop may follow it ──
  doc.emit('dragstart', dragStartEvent('session-a'))
  doc.emit('dragend', { target: chatTarget })
  assert.equal(doc.getElementById(HINT_ID), null)
  doc.emit('drop', dropEvent(chatTarget))
  assert.equal(inserted.length, 1, 'drop after dragend must be inert')

  // ── the current session is never referenced by itself ──
  doc.emit('dragstart', dragStartEvent('session-current'))
  doc.emit('drop', dropEvent(chatTarget))
  assert.deepEqual(notices, [{ level: 'info', text: 'dshDrag.info.self' }])
  assert.equal(inserted.length, 1)

  // ── with no composer on stage the drop is a no-op, not a crash ──
  {
    const blank = boot({ noSession: true })
    plugin.apply(blank.ctx)
    blank.doc.emit('dragstart', dragStartEvent('session-a'))
    blank.doc.emit('drop', dropEvent(chatTarget))
    assert.deepEqual(blank.inserted, [])
    assert.deepEqual(blank.notices, [])
  }

  // ── disposal takes the listeners and the hint with it ──
  for (const dispose of disposers) dispose()
  assert.equal(doc.count(), 0, 'disposal must remove every document listener')
  assert.equal(doc.getElementById(HINT_ID), null)

  console.log(`dsh-drag apply() wiring: passed (${BUNDLE})`)
}

await main()
