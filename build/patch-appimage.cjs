#!/usr/bin/env node
/**
 * Make a built AppImage launchable when running as root.
 *
 * Chromium refuses to start as root unless --no-sandbox is passed, and it checks
 * this before any application JavaScript runs, so the flag cannot be added from
 * the main process. electron-builder writes executableArgs only into the .desktop
 * file; AppRun's own `exec "$BIN"` forwards nothing, so a terminal launch under
 * root aborts with:
 *
 *   FATAL: Running as root without --no-sandbox is not supported.
 *
 * This script patches AppRun to append the flag only when the effective uid is 0,
 * then repacks the squashfs onto the original AppImage runtime so the result is
 * still a normal, self-executing AppImage. Regular users keep the sandbox.
 *
 * Usage: node build/patch-appimage.cjs [path/to/app.AppImage]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MARKER = 'FENXI_ROOT_SANDBOX_PATCH';

function log(msg) {
  console.log(`patch-appimage: ${msg}`);
}

function patchAppRun(dir) {
  const file = path.join(dir, 'AppRun');
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes(MARKER)) {
    log('AppRun already patched');
    return false;
  }
  const anchor = 'BIN="$APPDIR/fenxi-dl"';
  if (!text.includes(anchor)) {
    throw new Error('AppRun did not contain the expected BIN assignment');
  }
  const addition = [
    anchor,
    '',
    `# ${MARKER}: append --no-sandbox only when running as root.`,
    '# Chromium performs this check before any app code runs, so it cannot be',
    '# handled inside the main process. Non-root users keep the sandbox enabled.',
    // AppRun launches the binary with "${args[@]}" (a copy taken at startup),
    // so appending to "$@" has no effect - the array itself must be extended.
    'if [ "$(id -u)" = "0" ]; then',
    '  case " ${args[*]} " in',
    '    *" --no-sandbox "*)',
    '      ;;',
    '    *)',
    '      args+=("--no-sandbox" "--disable-gpu-sandbox")',
    '      NUMBER_OF_ARGS=${#args[@]}',
    '      ;;',
    '  esac',
    'fi',
  ].join('\n');
  fs.writeFileSync(file, text.replace(anchor, addition), { mode: 0o755 });
  log('AppRun patched');
  return true;
}

/**
 * Find the squashfs superblock offset inside an AppImage.
 *
 * A plain search for the "hsqs" magic is wrong: the AppImage runtime is a static
 * binary that can contain that byte sequence itself (this file has one at 32609
 * before the real image at 188392). Candidates are therefore validated against
 * the superblock fields instead.
 */
function findSquashfsOffset(buf) {
  const magic = Buffer.from('hsqs');
  let searchFrom = 0;
  while (searchFrom < buf.length) {
    const at = buf.indexOf(magic, searchFrom);
    if (at < 0) break;
    if (at + 96 <= buf.length) {
      const inodeCount = buf.readUInt32LE(at + 4);
      const blockSize = buf.readUInt32LE(at + 12);
      const major = buf.readUInt16LE(at + 28);
      const knownBlockSizes = [4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576];
      if (major === 4 && inodeCount > 0 && inodeCount < 1_000_000 && knownBlockSizes.includes(blockSize)) {
        return at;
      }
    }
    searchFrom = at + 1;
  }
  throw new Error('no valid squashfs superblock found in the AppImage');
}

/**
 * Read the compression id from a squashfs superblock so the repack uses the same
 * algorithm. Re-encoding with a different one changed an 81 MB image to 104 MB.
 */
function squashfsCompression(buf, offset) {
  const id = buf.readUInt16LE(offset + 20);
  return { 1: 'gzip', 2: 'lzma', 3: 'lzo', 4: 'xz', 5: 'lz4', 6: 'zstd' }[id] || 'gzip';
}

function repack(appImagePath) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fenxi-ai-'));
  try {
    // unsquashfs cannot read the file directly: the AppImage runtime prefix sits
    // in front of the squashfs image, so extract the payload first.
    const original = fs.readFileSync(appImagePath);
    const offset = findSquashfsOffset(original);
    const runtime = original.subarray(0, offset);
    const payload = path.join(work, 'payload.squashfs');
    fs.writeFileSync(payload, original.subarray(offset));

    const root = path.join(work, 'root');
    execFileSync('unsquashfs', ['-q', '-n', '-d', root, payload], { stdio: 'pipe' });
    if (!patchAppRun(root)) return;

    const squash = path.join(work, 'new.squashfs');
    const comp = squashfsCompression(original, offset);
    log(`repacking with ${comp} (matching the original image)`);
    execFileSync(
      'mksquashfs',
      [root, squash, '-root-owned', '-noappend', '-comp', comp, '-quiet'],
      { stdio: 'pipe' },
    );

    const out = Buffer.concat([runtime, fs.readFileSync(squash)]);
    fs.writeFileSync(appImagePath, out, { mode: 0o755 });
    log(`repacked ${path.basename(appImagePath)} (${(out.length / 1048576).toFixed(1)} MB)`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function main() {
  let target = process.argv[2];
  if (!target) {
    const dir = path.join(__dirname, '..', 'release');
    const found = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith('.AppImage')).sort()
      : [];
    if (found.length === 0) {
      log('no AppImage found; nothing to do');
      return;
    }
    // Prefer the newest artifact.
    target = path.join(dir, found[found.length - 1]);
  }
  if (!fs.existsSync(target)) {
    console.error(`patch-appimage: not found: ${target}`);
    process.exitCode = 1;
    return;
  }
  repack(target);
}

main();
