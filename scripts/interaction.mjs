// jsdom interaction test for the browser half of dsh-drag.
//
// Renders the real shipped loader bundle into jsdom, calls the plugin body the
// way the shell does — `plugin.apply(ctx)` and nothing else — and drives real
// bubbling events at real DOM nodes: a session row inside the sidebar tree and
// the chat area beside it. It proves the chip insertion rides
// conversation.input.for(actx).insertReference with the caret span, that the
// sidebar keeps its own handling, and that this plugin adds no DOM of its own
// (the browser's drag image and copy cursor are the entire feedback).
//
// Run: node scripts/interaction.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const dom = new JSDOM(`<!doctype html><html><body>
  <div role="tree" aria-label="sessions">
    <div role="treeitem" aria-selected="true" id="row-a">A 会话</div>
  </div>
  <main id="chat"></main>
</body></html>`, { url: 'https://dsh.local/' })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.Event = dom.window.Event
// jsdom doesn't ship TextEncoder; Node's own is the same API the browser gives
// the plugin, and Node's native btoa is byte-faithful too.
let capturedLoader = null
globalThis.window.__ModuleLoader__ = { load: (definition) => { capturedLoader = definition } }

const inserted = []
const notified = []

const actx = { tag: 'session-current' }
const sessions = {
  scope: (id) => (id === 'session-current' ? actx : undefined),
  list: {
    getSnapshot: () => ({
      current: 'session-current',
      byId: {
        'session-a': { id: 'session-a', displayTitle: 'A 会话' },
        'session-current': { id: 'session-current', displayTitle: 'Current' },
      },
    }),
    subscribe: () => () => {},
  },
}
const input = {
  caretSpan: () => ({ start: 5, end: 5 }),
  snapshot: { draft: '', draftRev: 11 },
  insertReference: (reference, span) => { inserted.push({ reference, span }); return true },
  notify: (level, text) => { notified.push({ level, text }) },
}
const registered = []
const disposers = []
const ctx = {
  effect(fn) { const dispose = fn(); disposers.push(dispose); return dispose },
  locale: {
    register: () => () => {},
    bind: () => (key) => key,
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

// The whole point: apply() is what mounts the surface. Nothing else is called.
plugin.apply(ctx)

const entry = registered[0]
if (entry === undefined) throw new Error('dock entry not registered')
if (entry.spec.name !== 'conversation.input.dock') throw new Error(`wrong slot: ${entry.spec.name}`)
if (entry.component(entry.spec.inject('session-a')) !== null) throw new Error('dock component must render null')

const chat = document.getElementById('chat')
const rowA = document.getElementById('row-a')
const bodyBefore = document.body.children.length

/**
 * A real bubbling event carrying the drag fields jsdom lacks. `defaultPrevented`
 * is jsdom's own (the event is cancelable), so preventDefault is observable.
 */
function dragEvent(type, target, { payload = undefined, x = 500, y = 300 } = {}) {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    clientX: { value: x },
    clientY: { value: y },
    dataTransfer: {
      value: {
        dropEffect: 'none',
        effectAllowed: '',
        getData: (kind) => (kind === 'text/plain' ? payload ?? '' : ''),
        setData() {},
      },
    },
  })
  return { event, target }
}

function fire(type, target, options) {
  const { event } = dragEvent(type, target, options)
  target.dispatchEvent(event)
  return event
}

// 1. apply() mounted a working surface: a full gesture lands one chip, and the
//    mention is the host's canonical form.
fire('dragstart', rowA, { payload: 'session-a', x: 10, y: 10 })
const over = fire('dragover', chat)
if (over.defaultPrevented !== true) throw new Error('dragover over the chat area must accept the drop')
if (over.dataTransfer.dropEffect !== 'copy') throw new Error('the accepted drop must claim the copy cursor')
const drop = fire('drop', chat)
if (drop.defaultPrevented !== true) throw new Error('drop over the chat area must be handled')
if (inserted.length !== 1) throw new Error(`expected one insertion, got ${inserted.length}`)
const mention = inserted[0].reference.ref
const expectedUri = `dsh-session:${Buffer.from(JSON.stringify('session-a')).toString('base64url')}`
if (mention !== `@[A 会话](${expectedUri})`) throw new Error(`mention mismatch: ${mention}`)
if (JSON.stringify(inserted[0].span) !== JSON.stringify({ start: 5, end: 5, draftRev: 11 })) {
  throw new Error(`span mismatch: ${JSON.stringify(inserted[0].span)}`)
}
if (inserted[0].reference.appearance !== 'session') throw new Error('appearance must be session')
if (notified.length !== 0) throw new Error(`unexpected notices: ${JSON.stringify(notified)}`)

// 2. No overlay: the surface drew nothing anywhere in the document.
if (document.body.children.length !== bodyBefore) throw new Error('the plugin must not add DOM nodes')
if (document.querySelector('[data-dsh-drag-hint], #dsh-drag-hint') !== null) throw new Error('a hint element survived')

// 3. Hovering the sidebar keeps the official reorder handling and inserts nothing.
fire('dragstart', rowA, { payload: 'session-a', x: 10, y: 10 })
const overSidebar = fire('dragover', rowA, { x: 10, y: 10 })
if (overSidebar.defaultPrevented !== false) throw new Error('the sidebar keeps its own dragover handling')
if (overSidebar.dataTransfer.dropEffect !== 'none') throw new Error('no drop effect may be claimed over the sidebar')
const dropSidebar = fire('drop', rowA, { x: 10, y: 10 })
if (dropSidebar.defaultPrevented !== false) throw new Error('a sidebar drop must stay official')
if (inserted.length !== 1) throw new Error('a sidebar drop inserted a chip')

// 4. A non-session payload (a workspace row key) never arms the surface.
fire('dragstart', rowA, { payload: 'workspace:ws-1' })
if (fire('dragover', chat).defaultPrevented !== false) throw new Error('a workspace drag must not arm the drop')

// 5. A drop after dragend is inert.
fire('dragstart', rowA, { payload: 'session-a' })
fire('dragend', rowA, { payload: 'session-a' })
fire('drop', chat)
if (inserted.length !== 1) throw new Error('drop after dragend inserted again')

// 6. Disposal clears the listeners: nothing further inserts.
for (const dispose of disposers) if (typeof dispose === 'function') dispose()
fire('dragstart', rowA, { payload: 'session-a' })
if (fire('dragover', chat).defaultPrevented !== false) throw new Error('listeners survived dispose')
fire('drop', chat)
if (inserted.length !== 1) throw new Error('a disposed surface inserted a chip')

console.log('dsh-drag jsdom interaction: 6/6 checks passed')
