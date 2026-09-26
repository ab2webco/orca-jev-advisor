// Imports a specifier, treating exactly one failure as "the optional
// dependency is missing" rather than a defect: node's own "this specifier
// does not resolve" error, when its message names the optional package.
// Everything else -- a syntax error in the target module, a runtime throw
// at module scope, any other missing module -- rethrows.
//
// Why this exists: scripts/fixture_shape.test.mjs used a bare
// `catch { SCENARIOS = null }` around its dynamic import of
// screenshot-panels.mjs, meant to catch exactly one thing -- a machine with
// no playwright installed, which this project's own README says Orca never
// installs for a cloned plugin. A bare catch swallows everything else too:
// a syntax error, or a renamed/missing export in screenshot-panels.mjs,
// silently became "playwright is not installed" and skipped every
// fixture-shape test instead of failing the run
// (odd/tasks/release-0.5.1.md JEVADV-35, review-3ca73b9da09b0927 R2/R3).

/**
 * True only when `error` is node's own "this specifier does not resolve"
 * failure AND its message names `optionalPackageName` -- the one shape this
 * module treats as "the optional dependency is not installed".
 *
 * Matched against the error's MESSAGE, not the specifier that was actually
 * imported: a module that itself does `import 'playwright'` at its own top
 * fails with `ERR_MODULE_NOT_FOUND` naming `playwright`, the package,
 * regardless of what specifier the caller passed to importOptional.
 */
export function isMissingOptionalPackageError (error, optionalPackageName) {
  return (
    error instanceof Error &&
    error.code === 'ERR_MODULE_NOT_FOUND' &&
    typeof error.message === 'string' &&
    error.message.includes(optionalPackageName)
  )
}

/**
 * Imports `specifier`, resolving to `null` ONLY when the failure is
 * isMissingOptionalPackageError's exact shape for `optionalPackageName`.
 * Any other failure -- a syntax error, a runtime throw at module scope, an
 * unrelated missing module -- rethrows, so a real defect in the optional
 * module fails whatever imports it instead of silently skipping.
 */
export async function importOptional (specifier, optionalPackageName) {
  try {
    return await import(specifier)
  } catch (error) {
    if (isMissingOptionalPackageError(error, optionalPackageName)) return null
    throw error
  }
}
