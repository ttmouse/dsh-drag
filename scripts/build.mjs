// Build for dsh-drag: wraps the browser half in the loader closure the DSH
// web plugin loader expects and copies the host half untouched.
//
//   window.__ModuleLoader__.load({ id: 'dsh-drag', factory: (require) => {
//     ...src/client.js...
//     module.exports = { ... }; return module.exports
//   } })
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const client = await readFile(join(root, 'src/client.js'), 'utf8')
const host = await readFile(join(root, 'src/host.js'), 'utf8')

const INDENT = '  '
const indented = client.trim().split('\n').map((line) => (line.trim() === '' ? '' : INDENT + line)).join('\n')

const wrapped = [
  "// Browser half of dsh-drag. Loaded through the web plugin loader",
  "// (window.__ModuleLoader__); built by scripts/build.mjs from src/client.js.",
  "window.__ModuleLoader__.load({ id: 'dsh-drag', factory: (require) => {",
  INDENT + 'var module = { exports: {} }; var exports = module.exports;',
  indented,
  `${INDENT}module.exports = { inject: pluginInject, apply, DragDock, __internals };`,
  `${INDENT}return module.exports`,
  '} })',
  '',
].join('\n')

await mkdir(join(root, 'lib'), { recursive: true })
await writeFile(join(root, 'lib/client.js'), wrapped)
await writeFile(join(root, 'lib/host.js'), host)
console.log('built lib/host.js, lib/client.js (loader closure)')
