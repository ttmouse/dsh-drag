// Host half of dsh-drag.
//
// Pure UI plugin: the browser half does all the work (a shell.overlay drop
// zone plus a sessions.open call). This half exists only so the package shows
// up in the host loader/cordis.yml and is listed by `dsh plugin add` like any
// other bundle. Node-safe: no window/document access at module scope.

/** Empty host plugin body — no host-side behavior. */
export function apply(): void {}
