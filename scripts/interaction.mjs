// jsdom interaction test for the browser half of dsh-drag.
//
// Complements test/smoke.mjs (fake-doc gestures): this one renders the real
// shipped loader bundle into jsdom with real DragEvents, a real DOM, and the
// real conversation.input facade shape — proving the hint element paints,
// follows the pointer, clears on drop/dragend, and that the chip insertion
// rides conversation.input.for(actx).insertReference with a captured span.
//
// Run: node scripts/interaction.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const dom = new JSDOM('<!doctype html><html><body><main id="chat"></main></body></html>', { url: 'https://dsh.local/' })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.Event = dom.window.Event
// jsdom's btoa wrapper throws from outside its vm realm; Node's native btoa
// is byte-faithful and matches what the real browser gives the plugin.
// (jsdom doesn't ship TextEncoder either; Node's own is the same API.)
// The bundle registers itself through the loader; capture the definition.
let capturedLoader = null
globalThis.window.__ModuleLoader__ = { load: (definition) => { capturedLoader = definition } }

const opened = []
const inserted = []
const notified = []

const actx = { tag: 'session-a' }
const sessions = {
  scope: (id) => (id === 'session-a' ? actx : undefined),
  list: {
    getSnapshot: () => ({ byId: { 'session-a': { id: 'session-a', displayTitle: 'A 会话' } } }),
    subscribe: () => () => {},
  },
}
const input = {
  insertReference: (reference, span) => { inserted.push({ reference, span }); return true },
  notify: (level, text) => { notified.push({ level, text }) },
}
const registered = []
const ctx = {
  effect(fn) { return fn() },
  locale: {
    register: () => () => {},
    bind: () => (key, params) => {
      const template = { 'hint.reference': '松开以引用会话「{title}」', 'info.self': 'i', 'error.insert': 'e' }[key] ?? key
      return params ? template.replace('{title}', params.title) : template
    },
  },
  inject(deps, callback) {
    if (JSON.stringify(deps) !== JSON.stringify(['slots', 'sessions', 'conversation'])) {
      throw new Error(`unexpected inject deps: ${deps}`)
    }
    callback({
      slots: {
        inject: (name, produce) => { produce(); return () => {} },
        register: (spec, component) => { registered.push({ spec, component }); return () => {} },
      },
      sessions,
      conversation: { input: { for: (scope) => { if (scope !== actx) throw new Error('wrong scope'); return input } } },
    })
  },
}

const source = readFileSync(join(root, 'lib/client.js'), 'utf8')
const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
await import(moduleUrl)
if (capturedLoader === null) throw new Error('bundle did not call window.__ModuleLoader__.load')
if (capturedLoader.id !== 'dsh-drag') throw new Error(`wrong loader id: ${capturedLoader.id}`)
const plugin = capturedLoader.factory(() => { throw new Error('no externals expected') })
plugin.apply(ctx)

const entry = registered[0]
if (entry === undefined) throw new Error('dock entry not registered')
if (entry.spec.name !== 'conversation.input.dock') throw new Error(`wrong slot: ${entry.spec.name}`)
const face = entry.spec.inject('session-a')
if (face.targetSessionId !== 'session-a') throw new Error('inject share carries the wrong session')

// The dock entry is a session-scoped marker (it renders null; the framework
// mounts/unmounts it with the composer). The document-level surface is what
// carries the interaction — created here with the same inject share.
if (entry.component(face) !== null) throw new Error('dock component must render null')

let hint = null
const surfaceDeps = {
  doc: document,
  sessions,
  t: ctx.locale.bind('dshDrag'),
  currentSessionId: 'session-other',
  inputActions: { captureInsertion: () => ({ start: 5, end: 5, draftRev: 11 }) },
  insertSessionReference: (reference, span) => input.insertReference(reference, span),
  notify: (level, text) => input.notify(level, text),
  onHint: (value) => {
    hint?.remove()
    hint = null
    if (value !== null) {
      hint = document.createElement('div')
      hint.id = 'dsh-drag-hint'
      hint.textContent = value.text
      hint.style.left = `${value.x}px`
      hint.style.top = `${value.y}px`
      document.body.appendChild(hint)
    }
  },
}
const surfaceDispose = plugin.__internals.createDropSurface(surfaceDeps)

function dragEvent(type, target, x, y) {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    target: { value: target },
    clientX: { value: x },
    clientY: { value: y },
    dataTransfer: { value: { dropEffect: 'none', setData() {} } },
  })
  event.preventDefault = () => { Object.defineProperty(event, 'defaultPrevented', { value: true, configurable: true }) }
  return event
}

const chat = document.getElementById('chat')
const sidebarRow = { closest: (selector) => (selector === '[data-row-key]'
  ? { getAttribute: (name) => (name === 'data-row-key' ? 'session:session-a' : null) }
  : null) }
const plain = { closest: () => null }

// 1. dragstart on a session row arms the surface.
document.dispatchEvent(dragEvent('dragstart', sidebarRow, 10, 10))
// 2. Hovering the chat area shows the hint element with the localized copy.
document.dispatchEvent(dragEvent('dragover', chat, 500, 300))
if (hint === null || !hint.textContent.includes('A 会话')) throw new Error('hint did not render over the chat area')
// 3. Hovering the sidebar hides it (official reorder territory).
document.dispatchEvent(dragEvent('dragover', sidebarRow, 10, 10))
if (hint !== null) throw new Error('hint stayed visible over the sidebar')
// 4. Dropping over the chat area inserts the canonical mention with the captured span.
document.dispatchEvent(dragEvent('drop', chat, 500, 300))
if (inserted.length !== 1) throw new Error(`expected one insertion, got ${inserted.length}`)
const mention = inserted[0].reference.ref
const expectedUri = `dsh-session:${Buffer.from(JSON.stringify('session-a')).toString('base64url')}`
if (mention !== `@[A 会话](${expectedUri})`) throw new Error(`mention mismatch: ${mention}`)
if (JSON.stringify(inserted[0].span) !== JSON.stringify({ start: 5, end: 5, draftRev: 11 })) {
  throw new Error(`span mismatch: ${JSON.stringify(inserted[0].span)}`)
}
if (inserted[0].reference.appearance !== 'session') throw new Error('appearance must be session')
if (hint !== null) throw new Error('hint survived the drop')

// 5. A second drop after dragend is inert.
document.dispatchEvent(dragEvent('dragstart', sidebarRow, 10, 10))
document.dispatchEvent(dragEvent('dragend', sidebarRow, 10, 10))
document.dispatchEvent(dragEvent('drop', chat, 500, 300))
if (inserted.length !== 1) throw new Error('drop after dragend inserted again')

// 6. Unmount clears the listeners: nothing further inserts.
surfaceDispose()
document.dispatchEvent(dragEvent('dragstart', sidebarRow, 10, 10))
document.dispatchEvent(dragEvent('drop', chat, 500, 300))
if (inserted.length !== 1) throw new Error('listeners survived dispose')

surfaceDispose()
console.log('dsh-drag jsdom interaction: 6/6 checks passed')
