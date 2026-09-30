// Build for dsh-drag: copies the two plain-JS halves into lib/ untouched.
// No bundler needed — both halves are dependency-free ES modules (the client
// half speaks to the host only through the cordis ctx passed to apply()).
import { cp, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

await mkdir(join(root, 'lib'), { recursive: true })
await cp(join(root, 'src/host.js'), join(root, 'lib/host.js'))
await cp(join(root, 'src/client.js'), join(root, 'lib/client.js'))
console.log('built lib/host.js, lib/client.js')
