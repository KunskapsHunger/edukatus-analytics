// Run with: npx ts-node src/generate-icons.ts
// Generates simple SVG-based PNG icons for the extension

import { writeFileSync } from 'fs';

const svg48 = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
  <rect width="48" height="48" rx="8" fill="#8b5cf6"/>
  <text x="24" y="32" text-anchor="middle" fill="white" font-family="system-ui" font-size="24" font-weight="700">P</text>
</svg>`;

const svg128 = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="20" fill="#8b5cf6"/>
  <text x="64" y="84" text-anchor="middle" fill="white" font-family="system-ui" font-size="64" font-weight="700">P</text>
</svg>`;

writeFileSync('icons/icon-48.svg', svg48);
writeFileSync('icons/icon-128.svg', svg128);
