// Host half of dsh-drag.
//
// Pure UI plugin: the browser half does all the work. This half exists only
// so the package shows up in the host loader/cordis.yml and is listed by
// `dsh plugin add` like any other bundle. Node-safe: no window/document
// access at module scope. Plain JS — the host loader imports this file as ESM.

/** Empty host plugin body — no host-side behavior. */
export function apply() {}
