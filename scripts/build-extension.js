import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist', 'extension');
const archive = join(root, 'dist', 'web-monitor-extension.zip');
const extensionFiles = [
  'manifest.json',
  'appport.toml',
  'feltdb.flow',
  'icons',
  'src/appport',
  'src/background',
  'src/content',
  'src/options',
  'src/popup',
  'src/shared'
];

rmSync(output, { recursive: true, force: true });
rmSync(archive, { force: true });
mkdirSync(output, { recursive: true });

for (const relativePath of extensionFiles) {
  const source = join(root, relativePath);
  if (!existsSync(source)) {
    throw new Error(`Missing extension input: ${relativePath}`);
  }
  cpSync(source, join(output, relativePath), { recursive: true });
}

const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
const requiredManifestFiles = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  manifest.options_page,
  ...Object.values(manifest.icons ?? {}),
  ...(manifest.content_scripts ?? []).flatMap((entry) => entry.js ?? [])
].filter(Boolean);

for (const relativePath of requiredManifestFiles) {
  if (!existsSync(join(output, relativePath))) {
    throw new Error(`Manifest references a missing file: ${relativePath}`);
  }
}

await build({
  entryPoints: [
    join(root, 'src/background/service-worker.js'),
    join(root, 'src/popup/popup.js'),
    join(root, 'src/options/options.js')
  ],
  outbase: root,
  outdir: output,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome124',
  chunkNames: 'src/chunks/[name]-[hash]',
  legalComments: 'none'
});

function filesUnder(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

const javascriptFiles = filesUnder(output).filter((path) => path.endsWith('.js'));

for (const path of javascriptFiles) {
  execFileSync(process.execPath, ['--check', path], {
    stdio: 'inherit'
  });
}

for (const requiredArtifact of ['feltdb.flow', 'appport.toml', 'src/background/service-worker.js']) {
  if (!existsSync(join(output, requiredArtifact))) {
    throw new Error(`Build is missing required artifact: ${requiredArtifact}`);
  }
}

try {
  execFileSync('zip', ['-q', '-r', archive, '.'], {
    cwd: output,
    stdio: 'inherit'
  });
} catch (error) {
  if (error?.code === 'ENOENT') {
    throw new Error('The zip command is required to create the extension archive.');
  }
  throw error;
}

console.log(`Built unpacked Chrome extension at ${output}`);
console.log(`Built Chrome extension archive at ${archive}`);
