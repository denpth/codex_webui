import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// node-pty's published macOS prebuild can lose the helper's executable bit.
// Repair the installed package so clean npm installs work without a manual chmod.
if (process.platform !== 'win32') {
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve('node-pty/package.json'));
  for (const relative of [`prebuilds/${process.platform}-${process.arch}/spawn-helper`, 'build/Release/spawn-helper']) {
    const helper = path.join(root, relative);
    if (fs.existsSync(helper)) fs.chmodSync(helper, fs.statSync(helper).mode | 0o111);
  }
}
