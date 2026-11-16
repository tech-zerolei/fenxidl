/**
 * afterPack hook — runs once per packaged target, for every platform.
 *
 * Two jobs:
 *
 * 1. Linux: electron-builder copies the project licence into the AppImage root,
 *    where the generated AppRun treats any LICENSE.txt as a EULA and blocks
 *    startup with a zenity agreement dialog. The licence is still shipped by
 *    `extraResources`, but under resources/ with a non-triggering name.
 *
 * 2. All platforms: harden the Electron fuses. The shipped Electron 33 binary
 *    has `RunAsNode`, `EnableNodeCliInspectArguments` and
 *    `EnableNodeOptionsEnvironmentVariable` ENABLED and `OnlyLoadAppFromAsar`
 *    DISABLED, which means a local user who controls the command line or the
 *    environment can run arbitrary code as the app (verified in the security
 *    review, V-17). Flipping them at pack time is the documented Electron
 *    mitigation.
 *
 * Fuse flipping is best-effort: packaging must not fail because a fuse is
 * already in the desired state or because the binary layout is unexpected. The
 * outcome is always logged.
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * Locate the packaged Electron executable for the current platform.
 *
 * The Linux binary is not named after `productName`: electron-builder derives it
 * from the package `name` field (`fenxi-dl`) or from an explicit
 * `build.linux.executableName`. Guessing a single candidate silently skipped
 * fuse hardening on Linux, so every plausible name is tried and the result is
 * verified to be a regular file.
 */
function executablePath(context) {
  const { electronPlatformName: platform, appOutDir, packager } = context;
  if (platform === 'linux') {
    const linux = packager.platformSpecificBuildOptions ?? {};
    const candidates = [
      linux.executableName,
      packager.appInfo.sanitizedName,
      packager.appInfo.productFilename.toLowerCase(),
      packager.appInfo.productFilename,
    ].filter(Boolean);
    for (const name of new Set(candidates)) {
      const candidate = path.join(appOutDir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    return path.join(appOutDir, candidates[0] ?? 'app');
  }
  const productName = packager.appInfo.productFilename;
  if (platform === 'win32') return path.join(appOutDir, `${productName}.exe`);
  if (platform === 'darwin') return path.join(appOutDir, `${productName}.app`, 'Contents', 'MacOS', productName);
  return null;
}

async function hardenFuses(context) {
  const exe = executablePath(context);
  if (!exe || !fs.existsSync(exe)) {
    console.log(`afterPack: no executable found for fuse hardening (${exe ?? 'unsupported platform'})`);
    return;
  }

  let fuses;
  try {
    fuses = require('@electron/fuses');
  } catch {
    console.log('afterPack: @electron/fuses is not installed; skipping fuse hardening');
    return;
  }
  const { flipFuses, FuseVersion, FuseV1Options } = fuses;

  const options = {
    version: FuseVersion.V1,
    // ELECTRON_RUN_AS_NODE=1 must not turn the app into a generic Node runtime.
    [FuseV1Options.RunAsNode]: false,
    // No --inspect into the packaged main process.
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    // Ignore NODE_OPTIONS from the environment.
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    // Only load the bundled app.asar, never an unpacked resources/app directory.
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  };
  // This fuse is only honoured on macOS/Windows; on Linux the underlying check
  // is not implemented, so flipping it there is a silent no-op that can still
  // break startup on a payload without the asar integrity header. Verified with
  // @electron/fuses 1.8.0 + Electron 33: the flip does NOT throw on Linux, so
  // this gate is deliberate defence, not error avoidance.
  if (context.electronPlatformName === 'darwin' || context.electronPlatformName === 'win32') {
    options[FuseV1Options.EnableEmbeddedAsarIntegrityValidation] = true;
  }

  try {
    await flipFuses(exe, options);
    console.log(`afterPack: electron fuses hardened (${path.basename(exe)})`);
  } catch (err) {
    console.log(`afterPack: could not harden fuses: ${err && err.message ? err.message : err}`);
  }
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName === 'linux') {
    const offending = path.join(context.appOutDir, 'LICENSE.txt');
    if (fs.existsSync(offending)) {
      fs.rmSync(offending, { force: true });
      console.log('afterPack: removed AppImage-root LICENSE.txt (would trigger EULA)');
    }
  }
  await hardenFuses(context);
};
