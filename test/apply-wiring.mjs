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
 * The fake document carries nothing but listener bookkeeping: this plugin draws
 * no UI of its own (the browser's drag image and copy cursor are the whole
 * feedback), so any element creation or lookup from the surface is a failure,
 * not a silent extra overlay.
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

/**
 * A document stub that records listeners per type and phase (so a missing mount
 * or a phase regression is visible) and dispatches events to whatever the
 * plugin installed. It has no createElement/getElementById on purpose: the
 * surface must not touch the DOM beyond its listener pair.
 */
function fakeDoc() {
  const listeners = new Map()
  const key = (type, capture) => `${type}${capture === true ? ':capture' : ''}`
  return {
    addEventListener(type, fn, capture) {
      const id = key(type, capture)
      const list = listeners.get(id) ?? []
      list.push(fn)
      listeners.set(id, list)
    },
    removeEventListener(type, fn, capture) {
      const list = listeners.get(key(type, capture)) ?? []
      const at = list.indexOf(fn)
      if (at >= 0) list.splice(at, 1)
    },
    emit(type, event, capture = false) {
      for (const fn of [...(listeners.get(key(type, capture)) ?? [])]) fn(event)
    },
    phases: () => [...listeners.keys()].sort(),
    count: () => [...listeners.values()].reduce((total, list) => total + list.length, 0),
  }
}

/** An event target outside the sidebar. */
const chatTarget = { closest: () => null }

/** A row inside the native sidebar tree. */
const sidebarTarget = { closest: (selector) => (selector === '[role="tree"]' ? {} : null) }

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
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.propagationStopped = true },
  }
}

function dropEvent(target) {
  return {
    target,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.propagationStopped = true },
  }
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
function boot({ currentSessionId = 'session-current', noSession = false, refuseInsert = false, throwOnFor = false } = {}) {
  const doc = fakeDoc()
  globalThis.document = doc
  /** What `sessions.list.current` answers: an id, or nothing on stage at all. */
  const current = noSession ? undefined : currentSessionId

  const inserted = []
  const notices = []
  const dictionaries = []
  const registered = []
  const rootDisposers = []
  const scopeDisposers = []

  const shell = {
    caretSpan: () => ({ start: 7, end: 7 }),
    snapshot: { draft: '', draftRev: 12 },
    insertReference: (reference, span) => { inserted.push({ reference, span }); return !refuseInsert },
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
        if (throwOnFor) throw new Error('conversation.input: session resolved no binding')
        return shell
      },
    },
  }

  const ctx = {
    effect(fn, label) {
      assert.equal(typeof label, 'string')
      const dispose = fn()
      if (typeof dispose === 'function') rootDisposers.push(dispose)
      return dispose
    },
    locale: {
      register: (ns, dicts) => { dictionaries.push({ ns, dicts }); return () => {} },
      bind: (ns) => (key) => `${ns}.${key}`,
    },
    inject(deps, callback) {
      assert.deepEqual(deps, ['slots', 'sessions', 'conversation'])
      // inject() is plugin({inject, apply}), so the callback's argument is the
      // dependency-gated scope ctx — a ctx with its own effect().
      callback({
        effect(fn, label) {
          assert.equal(typeof label, 'string')
          const dispose = fn()
          if (typeof dispose === 'function') scopeDisposers.push(dispose)
          return dispose
        },
        slots: {
          inject: (name, produce) => { registered.push(name); produce() },
          register: (spec, component) => { registered.push({ spec, component }); return () => {} },
        },
        sessions,
        conversation,
      })
    },
  }

  return { doc, ctx, inserted, notices, dictionaries, registered, rootDisposers, scopeDisposers }
}

async function main() {
  const plugin = await loadBundle()
  const { doc, ctx, inserted, notices, dictionaries, registered, rootDisposers, scopeDisposers } = boot()

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
  assert.deepEqual(
    doc.phases(),
    ['dragend', 'dragover:capture', 'dragstart', 'drop:capture'],
    'dragover/drop must be capture-phase so the composer never sees them',
  )
  assert.equal(rootDisposers.length, 1, 'only the dictionary registration rides the root fiber')
  assert.equal(scopeDisposers.length, 1, 'the surface must ride the inject scope, so re-injection cannot double-mount it')

  // ── one whole gesture, driven only at the document listeners apply() installed ──
  const start = dragStartEvent('session-a')
  doc.emit('dragstart', start)
  assert.equal(start.dataTransfer.effectAllowed, 'copyMove', 'the copy drop needs a legal effectAllowed')
  const over = dragOverEvent(chatTarget)
  doc.emit('dragover', over, true)
  assert.equal(over.defaultPrevented, true, 'dragover over the chat area must allow the drop')
  assert.equal(over.dataTransfer.dropEffect, 'copy', 'the copy badge is the whole affordance')
  assert.equal(over.propagationStopped, true, 'the taken gesture must not reach the composer')

  const drop = dropEvent(chatTarget)
  doc.emit('drop', drop, true)
  assert.equal(drop.defaultPrevented, true)
  assert.equal(drop.propagationStopped, true)
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
  doc.emit('dragover', overSidebar, true)
  assert.equal(overSidebar.defaultPrevented, false, 'the sidebar must keep its own dragover handling')
  assert.equal(overSidebar.propagationStopped, false, 'the sidebar gesture must reach the row handlers')
  assert.equal(overSidebar.dataTransfer.dropEffect, 'none', 'no drop effect is claimed over the sidebar')
  const dropSidebar = dropEvent(sidebarTarget)
  doc.emit('drop', dropSidebar, true)
  assert.equal(dropSidebar.defaultPrevented, false)
  assert.equal(dropSidebar.propagationStopped, false)
  assert.equal(inserted.length, 1, 'a sidebar drop must not insert')

  // ── workspace rows and other payloads stay inert ──
  for (const payload of ['workspace:ws-1', '/Users/douba/notes.md', '', 'session-gone']) {
    const inertStart = dragStartEvent(payload)
    doc.emit('dragstart', inertStart)
    assert.equal(inertStart.dataTransfer.effectAllowed, 'move', `payload ${JSON.stringify(payload)} must not be touched`)
    const inertOver = dragOverEvent(chatTarget)
    doc.emit('dragover', inertOver, true)
    assert.equal(inertOver.defaultPrevented, false, `payload ${JSON.stringify(payload)} must not arm the drop`)
    assert.equal(inertOver.propagationStopped, false, `payload ${JSON.stringify(payload)} must pass through untouched`)
    doc.emit('drop', dropEvent(chatTarget), true)
    assert.equal(inserted.length, 1, `payload ${JSON.stringify(payload)} must not insert`)
  }

  // ── a drag that ended is over: no drop may follow it ──
  doc.emit('dragstart', dragStartEvent('session-a'))
  doc.emit('dragend', { target: chatTarget })
  doc.emit('drop', dropEvent(chatTarget), true)
  assert.equal(inserted.length, 1, 'drop after dragend must be inert')

  // ── the current session is never referenced by itself ──
  doc.emit('dragstart', dragStartEvent('session-current'))
  doc.emit('drop', dropEvent(chatTarget), true)
  assert.deepEqual(notices, [{ level: 'info', text: 'dshDrag.info.self' }])
  assert.equal(inserted.length, 1)

  // ── a refused insertion surfaces a notice instead of failing silently ──
  {
    const refused = boot({ refuseInsert: true })
    plugin.apply(refused.ctx)
    refused.doc.emit('dragstart', dragStartEvent('session-a'))
    refused.doc.emit('drop', dropEvent(chatTarget), true)
    assert.equal(refused.inserted.length, 1, 'the insertion is attempted')
    assert.deepEqual(refused.notices, [{ level: 'error', text: 'dshDrag.error.insert' }])
  }

  // ── with no composer on stage the drop is a no-op, not a crash ──
  {
    const blank = boot({ noSession: true })
    plugin.apply(blank.ctx)
    blank.doc.emit('dragstart', dragStartEvent('session-a'))
    blank.doc.emit('drop', dropEvent(chatTarget), true)
    assert.deepEqual(blank.inserted, [])
    assert.deepEqual(blank.notices, [])
  }

  // ── a host that throws out of conversation.input.for must not escape a drop ──
  {
    const hostile = boot({ throwOnFor: true })
    plugin.apply(hostile.ctx)
    hostile.doc.emit('dragstart', dragStartEvent('session-a'))
    hostile.doc.emit('drop', dropEvent(chatTarget), true)
    assert.deepEqual(hostile.inserted, [], 'a throwing resolveFace inserts nothing')
    assert.deepEqual(hostile.notices, [], 'and reports nothing — there is no composer to report to')
  }

  // ── disposal takes the listeners with it ──
  for (const dispose of scopeDisposers) dispose()
  assert.equal(doc.count(), 0, 'scope disposal must remove every document listener')
  for (const dispose of rootDisposers) dispose()
  assert.equal(doc.count(), 0, 'and the root effect never owned any')

  console.log(`dsh-drag apply() wiring: passed (${BUNDLE})`)
}

await main()
