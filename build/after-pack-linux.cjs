/**
 * afterPack hook (Linux only).
 *
 * electron-builder copies the project licence into the AppImage root, where the
 * generated AppRun treats any LICENSE.txt as a EULA and blocks startup with a
 * zenity agreement dialog. The licence is still shipped, but under resources/
 * with a non-triggering file name.
 */
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;
  const root = context.appOutDir;
  const offending = path.join(root, 'LICENSE.txt');
  if (fs.existsSync(offending)) {
    fs.rmSync(offending, { force: true });
    console.log('afterPack: removed AppImage-root LICENSE.txt (would trigger EULA)');
  }
};
