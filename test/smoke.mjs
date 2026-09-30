/**
 * dsh-drag smoke test.
 *
 * Loads the real shipped browser bundle under a `window.__ModuleLoader__` stub
 * and drives the drop plumbing with synthetic drag events — no browser, no
 * React, no dependencies. The reference assertion recomputes the expected
 * mention with Node's own `Buffer` base64url encoder, which is what
 * `@deepseek-ai/dsh-session-reference` uses host-side, so a drift between this
 * bundle's browser-safe encoder and the host's canonical form fails here.
 *
 * Run: node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT_BUNDLE = join(here, '..', 'lib', 'client.js')
const PLUGIN_ID = 'dsh-drag'

/** Load the shipped bundle and return the module its factory produced. */
async function loadBundle() {
  let captured = null
  globalThis.window = { __ModuleLoader__: { load: (definition) => { captured = definition } } }
  await import(pathToFileURL(CLIENT_BUNDLE).href)
  assert.ok(captured !== null, 'the bundle must call window.__ModuleLoader__.load')
  assert.equal(captured.id, PLUGIN_ID)
  return captured.factory((specifier) => {
    if (specifier === 'react') return { createElement: () => null, useEffect: () => {}, useState: () => [null, () => {}] }
    throw new Error(`unexpected require: ${specifier}`)
  })
}

/** A document stub recording the capture-phase listeners the surface installs. */
function fakeDoc() {
  const listeners = new Map()
  return {
    addEventListener(type, fn) { listeners.set(type, fn) },
    removeEventListener(type) { listeners.delete(type) },
    emit(type, event) {
      const fn = listeners.get(type)
      assert.ok(fn !== undefined, `no listener installed for "${type}"`)
      fn(event)
    },
    installed: () => [...listeners.keys()].sort(),
  }
}

/** A drag target inside a sidebar row carrying `data-row-key`. */
function rowTarget(rowKey) {
  return {
    closest: (selector) => (selector === '[data-row-key]'
      ? { getAttribute: (name) => (name === 'data-row-key' ? rowKey : null) }
      : null),
  }
}

/** A drag target anywhere else in the window. */
function plainTarget() {
  return { closest: () => null }
}

function dragStartEvent(target) {
  return { target, dataTransfer: { effectAllowed: '', setData() {} } }
}

function dragOverEvent(target, clientX = 500, clientY = 300) {
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
  return { target, clientX: 500, clientY: 300, defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
}

/** One session list snapshot with the given rows. */
function sessionsWith(rows) {
  return { list: { getSnapshot: () => ({ byId: rows }) } }
}

/** The host's own canonical mention, encoded with Node's Buffer base64url. */
function hostMention(sessionId, label) {
  const escaped = (label ?? sessionId).replace(/[\\\]]/gu, (match) => `\\${match}`)
  return `@[${escaped}](dsh-session:${Buffer.from(JSON.stringify(sessionId), 'utf8').toString('base64url')})`
}

/** Hints the surface actually showed (every drop also clears with a null). */
function shownHints(calls) {
  return calls.hints.filter(hint => hint !== null)
}

/** Drive one whole gesture and report what the surface did. */
function gesture({ bundle, rows, currentSessionId = 'session-current' }) {
  const calls = { inserts: [], notices: [], hints: [] }
  const doc = fakeDoc()
  const dispose = bundle.__internals.createDropSurface({
    doc,
    sessions: sessionsWith(rows),
    t: (key, params) => `${key}${params === undefined ? '' : `(${params.title})`}`,
    currentSessionId,
    inputActions: { captureInsertion: () => ({ start: 3, end: 3, draftRev: 7 }) },
    insertSessionReference: (reference, span) => { calls.inserts.push({ reference, span }); return true },
    notify: (level, text) => { calls.notices.push({ level, text }) },
    onHint: (hint) => { calls.hints.push(hint) },
  })
  return { doc, dispose, calls }
}

async function main() {
  const bundle = await loadBundle()

  // ── plugin surface ──
  assert.deepEqual(bundle.inject, ['slots', 'sessions', 'conversation', 'locale'])
  assert.equal(typeof bundle.apply, 'function')
  assert.equal(typeof bundle.__internals.createDropSurface, 'function')

  // ── mention encoding matches the host's canonical form ──
  const { formatSessionMention, encodeSessionUri } = bundle.__internals
  assert.equal(
    encodeSessionUri('session-a'),
    `dsh-session:${Buffer.from(JSON.stringify('session-a')).toString('base64url')}`,
  )
  assert.equal(formatSessionMention('session-a', 'A 会话'), hostMention('session-a', 'A 会话'))
  assert.equal(formatSessionMention('session-a', undefined), hostMention('session-a', undefined))
  assert.equal(
    formatSessionMention('session-a', 'weird ] \\ label'),
    hostMention('session-a', 'weird ] \\ label'),
  )
  assert.match(formatSessionMention('session-a', 'weird ] label'), /^@\[weird \\\] label\]\(dsh-session:[A-Za-z0-9_-]+\)$/)

  // ── dropping a session row into the chat area inserts one chip ──
  {
    const rows = { 'session-a': { displayTitle: 'A 会话' }, 'session-current': { displayTitle: 'Current' } }
    const run = gesture({ bundle, rows })
    run.doc.emit('dragstart', dragStartEvent(rowTarget('session:session-a')))
    const over = dragOverEvent(plainTarget())
    run.doc.emit('dragover', over)
    assert.equal(over.defaultPrevented, true, 'dragover over the chat area must allow the drop')
    assert.equal(over.dataTransfer.dropEffect, 'copy')
    assert.deepEqual(run.calls.hints.at(-1), { text: 'hint.reference(A 会话)', x: 514, y: 318 })

    const drop = dropEvent(plainTarget())
    run.doc.emit('drop', drop)
    assert.equal(drop.defaultPrevented, true)
    assert.equal(run.calls.hints.at(-1), null)
    assert.equal(run.calls.notices.length, 0)
    assert.deepEqual(run.calls.inserts, [{
      reference: {
        source: 'reference',
        ref: hostMention('session-a', 'A 会话'),
        label: 'A 会话',
        appearance: 'session',
        clipboardText: hostMention('session-a', 'A 会话'),
      },
      span: { start: 3, end: 3, draftRev: 7 },
    }])
    assert.deepEqual(run.doc.installed(), ['dragend', 'dragover', 'dragstart', 'drop'])
    run.dispose()
    assert.deepEqual(run.doc.installed(), [])
  }

  // ── a drop back on the sidebar keeps its official reorder behavior ──
  {
    const rows = { 'session-a': { displayTitle: 'A 会话' } }
    const run = gesture({ bundle, rows })
    run.doc.emit('dragstart', dragStartEvent(rowTarget('session:session-a')))
    const over = dragOverEvent(rowTarget('session:session-a'))
    run.doc.emit('dragover', over)
    assert.equal(over.defaultPrevented, false, 'the sidebar keeps its own dragover handling')
    assert.equal(shownHints(run.calls).length, 0, 'no chat-area hint over the sidebar')
    const drop = dropEvent(rowTarget('session:session-a'))
    run.doc.emit('drop', drop)
    assert.equal(drop.defaultPrevented, false)
    assert.equal(run.calls.inserts.length, 0)
    run.dispose()
  }

  // ── other drags stay inert ──
  {
    const rows = { 'session-a': { displayTitle: 'A 会话' } }
    const workspace = gesture({ bundle, rows })
    workspace.doc.emit('dragstart', dragStartEvent(rowTarget('workspace:ws-1')))
    workspace.doc.emit('dragover', dragOverEvent(plainTarget()))
    workspace.doc.emit('drop', dropEvent(plainTarget()))
    assert.equal(workspace.calls.inserts.length, 0)
    assert.equal(shownHints(workspace.calls).length, 0)
    workspace.dispose()

    const unknown = gesture({ bundle, rows: {} })
    unknown.doc.emit('dragstart', dragStartEvent(rowTarget('session:session-gone')))
    unknown.doc.emit('drop', dropEvent(plainTarget()))
    assert.equal(unknown.calls.inserts.length, 0)
    assert.equal(shownHints(unknown.calls).length, 0)
    unknown.dispose()

    const textless = gesture({ bundle, rows })
    textless.doc.emit('drop', dropEvent(plainTarget()))
    assert.equal(textless.calls.inserts.length, 0, 'a drop without a dragstart is inert')
    textless.dispose()
  }

  // ── a gesture that ends without dropping clears the hint ──
  {
    const rows = { 'session-a': { displayTitle: 'A 会话' } }
    const run = gesture({ bundle, rows })
    run.doc.emit('dragstart', dragStartEvent(rowTarget('session:session-a')))
    run.doc.emit('dragover', dragOverEvent(plainTarget()))
    assert.notEqual(run.calls.hints.at(-1), null)
    run.doc.emit('dragend', { target: rowTarget('session:session-a') })
    assert.equal(run.calls.hints.at(-1), null)
    run.doc.emit('drop', dropEvent(plainTarget()))
    assert.equal(run.calls.inserts.length, 0, 'no drop may follow a dragend')
    run.dispose()
  }

  // ── the current session is never referenced by itself ──
  {
    const rows = { 'session-current': { displayTitle: 'Current' } }
    const run = gesture({ bundle, rows })
    run.doc.emit('dragstart', dragStartEvent(rowTarget('session:session-current')))
    run.doc.emit('drop', dropEvent(plainTarget()))
    assert.deepEqual(run.calls.notices, [{ level: 'info', text: 'info.self' }])
    assert.equal(run.calls.inserts.length, 0)
    run.dispose()
  }

  // ── a refused insertion surfaces a notice instead of failing silently ──
  {
    const rows = { 'session-a': { displayTitle: 'A 会话' } }
    const doc = fakeDoc()
    const notices = []
    const dispose = bundle.__internals.createDropSurface({
      doc,
      sessions: sessionsWith(rows),
      t: (key) => key,
      currentSessionId: 'session-current',
      inputActions: { captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }) },
      insertSessionReference: () => false,
      notify: (level, text) => { notices.push({ level, text }) },
      onHint: () => {},
    })
    doc.emit('dragstart', dragStartEvent(rowTarget('session:session-a')))
    doc.emit('drop', dropEvent(plainTarget()))
    assert.deepEqual(notices, [{ level: 'error', text: 'error.insert' }])
    dispose()
  }

  // ── apply() wires the dock slot and the per-session insertion face ──
  {
    const registered = []
    const slotInjects = []
    const dictionaries = []
    const bound = []
    const forCalls = []
    const actx = { scope: 'session-a' }
    const sessions = {
      scope: (id) => (id === 'session-a' ? actx : undefined),
      list: { getSnapshot: () => ({ byId: {} }) },
    }
    const insertions = []
    const ctx = {
      effect: (fn) => fn(),
      locale: {
        register: (ns, dicts) => { dictionaries.push({ ns, dicts }); return () => {} },
        bind: (ns) => { bound.push(ns); return (key) => `${ns}.${key}` },
      },
      inject: (deps, callback) => {
        assert.deepEqual(deps, ['slots', 'sessions', 'conversation'])
        callback({
          slots: {
            inject: (name, produce) => { slotInjects.push(name); produce() },
            register: (spec, component) => { registered.push({ spec, component }); return () => {} },
          },
          sessions,
          conversation: {
            input: {
              for: (scope) => {
                forCalls.push(scope)
                return {
                  insertReference: (reference, span) => { insertions.push({ reference, span }); return true },
                  notify: () => {},
                }
              },
            },
          },
        })
      },
    }
    bundle.apply(ctx)

    assert.deepEqual(bound, [NS_OF(bundle)])
    assert.deepEqual(dictionaries.map(entry => entry.ns), [NS_OF(bundle)])
    assert.deepEqual(Object.keys(dictionaries[0].dicts), ['zh', 'en'])
    assert.deepEqual(
      Object.keys(dictionaries[0].dicts.zh).sort(),
      Object.keys(dictionaries[0].dicts.en).sort(),
      'both dictionaries must carry the same keys',
    )
    assert.deepEqual(slotInjects, ['conversation.input.dock'])
    assert.equal(registered.length, 1)
    assert.equal(registered[0].spec.name, 'conversation.input.dock')
    assert.equal(registered[0].spec.registrant, 'dsh-drag')
    assert.equal(typeof registered[0].component, 'function')

    const face = registered[0].spec.inject('session-a')
    assert.equal(face.targetSessionId, 'session-a')
    assert.equal(face.sessions, sessions)
    assert.equal(face.t('info.self'), `${NS_OF(bundle)}.info.self`)
    assert.equal(face.insertSessionReference({ ref: 'x' }, { start: 0, end: 0, draftRev: 2 }), true)
    assert.deepEqual(forCalls, [actx])
    assert.deepEqual(insertions, [{ reference: { ref: 'x' }, span: { start: 0, end: 0, draftRev: 2 } }])

    // An unknown Session scope resolves nothing instead of throwing.
    assert.equal(registered[0].spec.inject('session-gone').insertSessionReference({}, {}), false)
  }

  // ── the shipped bundle is the closure-factory artifact the loader expects ──
  {
    const source = readFileSync(CLIENT_BUNDLE, 'utf8')
    assert.match(source, /window\.__ModuleLoader__\.load\(\{ id: 'dsh-drag', factory: \(require\) => \{/)
    assert.match(source, /module\.exports = \{[\s\S]*\n  return module\.exports\n\} \}\)\n$/)
  }

  console.log('dsh-drag: smoke test passed')
}

/** The locale namespace this plugin registers, read off the plugin itself. */
function NS_OF(bundle) {
  assert.equal(typeof bundle.apply, 'function')
  return 'dshDrag'
}

await main()
