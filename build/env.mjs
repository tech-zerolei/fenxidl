/**
 * Shared build settings for the esbuild scripts in this directory.
 *
 * Sourcemap policy (used by build-main, build-renderer, build-test, build:e2e
 * and build:integration):
 *
 *   --dev                     on  (external `.js.map` next to the bundle)
 *   FENXIDL_SOURCEMAP=1       force on
 *   FENXIDL_SOURCEMAP=inline  inline as a data URL (single-file debugging)
 *   FENXIDL_SOURCEMAP=0       force off
 *   FENXIDL_DEV=1             on
 *   (nothing)                 off — the release default
 *
 * Both a CLI flag and an environment variable are accepted because the npm
 * scripts must also work in cmd.exe / PowerShell, where `FOO=1 cmd` is not valid
 * syntax. Explicit env settings win over `--dev`.
 *
 * Rationale: shipping `.map` files roughly doubles the packaged app size and
 * exposes the original TypeScript, so release builds keep them off while
 * `npm run build:dev` produces readable stack traces.
 */

/** True when the invoking command line contains `--dev`. */
export function devMode() {
  return process.argv.includes('--dev') || process.env.FENXIDL_DEV === '1';
}

/** @returns {false | 'inline' | true} value accepted by esbuild's `sourcemap`. */
export function sourcemapMode() {
  const raw = process.env.FENXIDL_SOURCEMAP?.trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'yes') return true;
  if (raw === 'inline') return 'inline';
  if (raw === '0' || raw === 'false' || raw === 'no') return false;
  return devMode() ? true : false;
}

/** Human readable label for log lines. */
export function sourcemapLabel(mode) {
  if (mode === false) return 'off';
  if (mode === 'inline') return 'inline';
  return 'external';
}
