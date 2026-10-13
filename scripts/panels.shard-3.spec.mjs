// Shard 3 of the four `npm run test:panels` runs in parallel; see the note
// at the top of panels.spec.mjs.
process.env.PANELS_SPEC_SHARD = '3/4'
await import('./panels.spec.mjs')
