import { build } from 'esbuild';
import { mkdir, rm, copyFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
if (manifest.version !== pkg.version) throw new Error('Manifest/package versions differ');
await rm('dist/extension', { recursive: true, force: true });
await mkdir('dist/extension', { recursive: true });
await build({ entryPoints: ['src/background.ts', 'src/workspace.ts', 'src/worker.ts'], outdir: 'dist/extension', bundle: true, format: 'esm', target: 'chrome116', legalComments: 'none' });
for (const file of ['manifest.json', 'workspace.html', 'workspace.css']) await copyFile(file, `dist/extension/${file}`);
for (const file of ['README.md', 'PRIVACY.md']) await copyFile(file, `dist/extension/${file}`);
console.log('Built unpacked MV3 extension: dist/extension');
