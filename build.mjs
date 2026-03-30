import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'fs';
import { build } from 'esbuild';

// 1. Clean
rmSync('dist', { recursive: true, force: true });
rmSync('build-firefox', { recursive: true, force: true });

// 2. Bundle each entry as self-contained IIFE (no import/export)
const entries = [
  { in: 'src/content.ts', out: 'dist/content.js' },
  { in: 'src/background.ts', out: 'dist/background.js' },
  { in: 'src/popup/index.ts', out: 'dist/popup.js' },
  { in: 'src/dashboard.ts', out: 'dist/dashboard.js' },
];

for (const entry of entries) {
  await build({
    entryPoints: [entry.in],
    outfile: entry.out,
    bundle: true,
    format: 'iife',
    target: 'es2022',
    minify: false,
    sourcemap: false,
  });
  console.log(`  ${entry.out}`);
}

// 3. Read base manifest template
const manifest = {
  manifest_version: 3,
  name: 'Progress Analytics',
  version: '0.1.0',
  description: 'Analytics dashboard for Progress school administration.',
  permissions: ['storage', 'activeTab'],
  host_permissions: ['https://progress.edukatus.se/*'],
  content_scripts: [{
    matches: ['https://progress.edukatus.se/*'],
    js: ['dist/content.js'],
    run_at: 'document_idle',
  }],
  action: { default_title: 'Progress Analytics' },
  icons: { '48': 'icons/icon-48.svg', '128': 'icons/icon-128.svg' },
};

// 4. Chrome/Edge manifest (service_worker, no type:module needed for IIFE)
const chromeManifest = {
  ...manifest,
  background: { service_worker: 'dist/background.js' },
};
writeFileSync('manifest.json', JSON.stringify(chromeManifest, null, 2));

// 5. Firefox manifest (background.scripts)
const firefoxManifest = {
  ...manifest,
  background: { scripts: ['dist/background.js'] },
  browser_specific_settings: {
    gecko: { id: 'edukatus-analytics@example.com', strict_min_version: '109.0' },
  },
};

mkdirSync('build-firefox', { recursive: true });
cpSync('dist', 'build-firefox/dist', { recursive: true });
cpSync('icons', 'build-firefox/icons', { recursive: true });
cpSync('popup.html', 'build-firefox/popup.html');
cpSync('dashboard.html', 'build-firefox/dashboard.html');
cpSync('privacy.html', 'build-firefox/privacy.html');
writeFileSync('build-firefox/manifest.json', JSON.stringify(firefoxManifest, null, 2));

console.log('\nBuilt for Chrome/Edge: ./ (load unpacked from extension root)');
console.log('Built for Firefox: ./build-firefox/ (load from build-firefox/)');
