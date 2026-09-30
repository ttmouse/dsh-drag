// Interaction test for the browser half of dsh-drag.
//
// Renders lib/client.js's apply() into jsdom the way the dsh web loader does
// (module import + apply(ctx)) and drives real DragEvents:
//   - dragging a session id highlights the transcript scrollport,
//   - dropping inside it calls sessions.open(sessionId) — never for unknown ids,
//   - dropping outside the transcript, or dragging foreign text, is a no-op.
//
// Run: node scripts/interaction.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** The zh copy lib/client.js ships (the test asserts the aria-label uses it). */
const LABELS_ZH = '松开以打开该会话'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://dsh.local/' })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.Event = dom.window.Event
globalThis.DataTransfer = dom.window.DataTransfer

// The conversation transcript the plugin targets.
const scrollport = document.createElement('div')
scrollport.setAttribute('data-conversation-scroll', '')
document.body.appendChild(scrollport)

const opened = []
const sessions = {
  list: {
    getSnapshot: () => ({ byId: { 'sess-1': { id: 'sess-1', displayTitle: 'One' } } }),
    subscribe: () => () => {},
  },
  open: (id) => { opened.push(id) },
}
const effects = []
const ctx = {
  locale: { current: 'zh' },
  sessions,
  slots: {},
  effect(fn, label) {
    const dispose = fn()
    effects.push({ dispose, label })
  },
}

const source = readFileSync(join(root, 'lib/client.js'), 'utf8')
const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
const plugin = await import(moduleUrl)
plugin.apply(ctx)
if (effects.length !== 2) throw new Error(`expected 2 effects (style + zone), got ${effects.length}`)

const zone = document.getElementById('dsh-drag-zone')
if (!zone) throw new Error('overlay drop zone not mounted')

function rect(el, top, left, width, height) {
  el.getBoundingClientRect = () => ({
    top, left, width, height,
    right: left + width, bottom: top + height, x: left, y: top,
    toJSON: () => ({}),
  })
}
// Scrollport occupies viewport 100..500 x 200..600.
rect(scrollport, 200, 100, 400, 400)

function dragEvent(type, x, y, text) {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true })
  event.clientX = x
  event.clientY = y
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      data: { 'text/plain': text },
      getData: (kind) => (kind === 'text/plain' ? text : ''),
      setData() {},
      dropEffect: 'none',
    },
  })
  return event
}

// 1. Hovering a real session id shows the zone...
document.dispatchEvent(dragEvent('dragover', 300, 300, 'sess-1'))
if (zone.getAttribute('data-dsh-drag-active') !== 'true') throw new Error('zone did not activate on session drag')
if (zone.getAttribute('aria-label') !== LABELS_ZH) throw new Error('zh label missing')
// 2. ...and dropping inside the transcript opens the session.
document.dispatchEvent(dragEvent('drop', 300, 300, 'sess-1'))
if (JSON.stringify(opened) !== JSON.stringify(['sess-1'])) throw new Error(`sessions.open not called once with sess-1: ${JSON.stringify(opened)}`)
if (zone.getAttribute('data-dsh-drag-active') !== 'false') throw new Error('zone did not deactivate after drop')

// 3. Dropping outside the transcript area is a no-op (zone still shows).
document.dispatchEvent(dragEvent('dragover', 30, 30, 'sess-1'))
document.dispatchEvent(dragEvent('drop', 30, 30, 'sess-1'))
if (opened.length !== 1) throw new Error(`drop outside transcript opened a session: ${JSON.stringify(opened)}`)

// 4. Foreign payloads (file paths, workspace rows) never activate the zone.
document.dispatchEvent(dragEvent('dragover', 300, 300, '/Users/douba/Projects/file.txt'))
if (zone.getAttribute('data-dsh-drag-active') !== 'false') throw new Error('zone activated for non-session payload')

// 5. Unknown session id: zone highlights (payload looks like a session) but
//    drop does not touch the controller.
document.dispatchEvent(dragEvent('dragover', 300, 300, 'ghost'))
document.dispatchEvent(dragEvent('drop', 300, 300, 'ghost'))
if (opened.length !== 1) throw new Error(`unknown id reached sessions.open: ${JSON.stringify(opened)}`)

// 6. dragend hides the zone.
document.dispatchEvent(dragEvent('dragover', 300, 300, 'sess-1'))
document.dispatchEvent(dragEvent('dragend', 300, 300, 'sess-1'))
if (zone.getAttribute('data-dsh-drag-active') !== 'false') throw new Error('dragend did not hide the zone')

// 7. Unload removes the zone and listeners: a drag after disposal is inert.
for (const { dispose } of effects) dispose()
if (document.getElementById('dsh-drag-zone')) throw new Error('zone survived unload')
document.dispatchEvent(dragEvent('dragover', 300, 300, 'sess-1'))
document.dispatchEvent(dragEvent('drop', 300, 300, 'sess-1'))
if (opened.length !== 1) throw new Error('listeners survived unload')

console.log('dsh-drag interaction: 7/7 checks passed')
