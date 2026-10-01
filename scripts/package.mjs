import { spawnSync } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const destination = resolve(`dist/transaction-to-excel-${pkg.version}.zip`);
await rm(destination, { force: true });
const result = spawnSync('zip', ['-q', '-r', destination, '.'], { cwd: 'dist/extension', stdio: 'inherit' });
if (result.status !== 0) throw new Error('Packaging failed; build first and install zip');
console.log(`Packaged dist/transaction-to-excel-${pkg.version}.zip`);
