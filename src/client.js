/**
 * dsh-drag — browser half.
 *
 * Drag a session row from the sidebar's session list into the transcript
 * (chat history) area to open it.
 *
 * The sidebar rows are already native HTML5 drag sources: ui-workspace's
 * SessionNodeItem sets `dataTransfer.setData('text/plain', node.id)` on
 * dragstart (verified in the 0.1.5-rc.2 bundle). This plugin adds the missing
 * drop side: a `shell.overlay` entry (the layout's frame-wide, click-through
 * floating layer) that listens for `dragover` on the document, highlights the
 * conversation column while the payload is a bare session id, and on `drop`
 * calls `ctx.sessions.open(sessionId)` — the same call the sidebar row's
 * click makes. Plain sessions only: subagent-addressed ids never appear in
 * the drag payload, and ids absent from the list snapshot are ignored.
 */

/** The overlay entry id in the `shell.overlay` list slot. */
const PLUGIN_ID = 'dsh-drag'

/** Marker attribute on the active conversation scrollport (ui-conversation). */
const SCROLLPORT_SELECTOR = '[data-conversation-scroll]'

/** Drop-zone visual: a dashed accent border inside the transcript area. */
const CSS = [
  '[data-dsh-drag-active] {',
  '  position: fixed;',
  '  z-index: 30;',
  '  pointer-events: none;',
  '  border: 2px dashed var(--ds-brand, #4d6bfe);',
  '  border-radius: 12px;',
  '  background: color-mix(in srgb, var(--ds-brand, #4d6bfe) 8%, transparent);',
  '  transition: opacity 120ms ease;',
  '  opacity: 1;',
  '}',
  '[data-dsh-drag-active="false"] { opacity: 0; }',
].join('\n')

/** Locale copy for the overlay's accessible label. */
const LABELS = {
  en: 'Drop to open this conversation',
  zh: '松开以打开该会话',
}

/** True when the payload is a bare session id worth opening. Sidebar drags
 *  put a raw session id on the payload; file paths and prose never qualify. */
function isPlausibleSessionId(text) {
  return typeof text === 'string'
    && /^[A-Za-z0-9_-]{1,128}$/.test(text)
}

/**
 * Resolve the transcript scrollport's viewport rect, or null when the
 * conversation view is not mounted (plugin page, hero-only views).
 */
function scrollportRect() {
  const el = document.querySelector(SCROLLPORT_SELECTOR)
  return el ? el.getBoundingClientRect() : null
}

function apply(ctx) {
  const label = () => (LABELS[ctx.locale?.current] ?? LABELS.en)

  ctx.effect(() => {
    const style = document.createElement('style')
    style.id = 'dsh-drag-style'
    style.textContent = CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'dsh-drag: style')

  ctx.effect(() => {
    const zone = document.createElement('div')
    zone.id = 'dsh-drag-zone'
    zone.setAttribute('data-dsh-drag-active', 'false')
    zone.setAttribute('role', 'region')
    zone.setAttribute('aria-label', label())
    document.body.appendChild(zone)

    let visible = false
    let overTranscript = false

    const paint = () => {
      const rect = scrollportRect()
      if (!visible || !rect) {
        zone.setAttribute('data-dsh-drag-active', 'false')
        return
      }
      zone.style.left = `${Math.round(rect.left + 4)}px`
      zone.style.top = `${Math.round(rect.top + 4)}px`
      zone.style.width = `${Math.max(0, Math.round(rect.width - 8))}px`
      zone.style.height = `${Math.max(0, Math.round(rect.height - 8))}px`
      zone.setAttribute('data-dsh-drag-active', 'true')
    }

    const show = () => {
      if (!visible) {
        visible = true
        overTranscript = false
        paint()
      }
    }

    const hide = () => {
      visible = false
      overTranscript = false
      zone.setAttribute('data-dsh-drag-active', 'false')
    }

    const payloadOf = (event) => {
      const text = event.dataTransfer?.getData('text/plain') ?? ''
      return isPlausibleSessionId(text) ? text : null
    }

    const onDragOver = (event) => {
      if (visible) event.preventDefault()
    }

    const onDocumentDragOver = (event) => {
      const sessionId = payloadOf(event)
      if (!sessionId) return
      show()
      // allow-drop: the default action must be prevented for drop to fire.
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
      const rect = scrollportRect()
      overTranscript = rect !== null
        && event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom
      paint()
    }

    const onDrop = (event) => {
      const sessionId = payloadOf(event)
      if (!sessionId) return
      event.preventDefault()
      const rect = scrollportRect()
      const inside = rect !== null
        && event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom
      hide()
      if (!inside) return
      // Same write the sidebar row's click performs; unknown ids fail loud
      // inside the controller and must not touch the current selection.
      const known = ctx.sessions.list.getSnapshot().byId[sessionId]
      if (!known) return
      ctx.sessions.open(sessionId)
    }

    const onDragEnd = () => { hide() }

    document.addEventListener('dragover', onDocumentDragOver, true)
    document.addEventListener('drop', onDrop, true)
    document.addEventListener('dragend', onDragEnd, true)
    document.addEventListener('dragleave', onDragEnd, true)
    window.addEventListener('dragover', onDragOver)

    return () => {
      document.removeEventListener('dragover', onDocumentDragOver, true)
      document.removeEventListener('drop', onDrop, true)
      document.removeEventListener('dragend', onDragEnd, true)
      document.removeEventListener('dragleave', onDragEnd, true)
      window.removeEventListener('dragover', onDragOver)
      zone.remove()
    }
  }, 'dsh-drag: overlay drop zone')
}

/** `slots` for the overlay seat; `sessions` for list + open; `locale` optional. */
export const inject = ['slots', 'sessions', 'locale']

export { apply }
