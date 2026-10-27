// The name this plugin puts on its render tasks and on what it reports to the
// manifest. The engine keeps each dispatcher's outputs apart, so the tasks, the
// no-output report and the recorded hashes this plugin seeds from all have to
// say the same thing — one constant, so they cannot drift.
//
// Why apart: an entity can be a page here and the source of preset
// derivatives in mikser-io-assets. This plugin skips a seed whose input hash is
// unchanged; assets schedules it anyway when its preset moves. Without a name
// on the tasks the manifest read a cycle of preset renders as the entity no
// longer producing its page, and unlinked the page.
export const DISPATCHER = 'layouts'
