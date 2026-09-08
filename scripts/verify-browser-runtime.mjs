import { createRequire } from 'node:module';
import { access } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const version = require('playwright/package.json').version;
if (version !== '1.62.1') throw new Error(`Update the pinned CI image together with Playwright (installed ${version}).`);
await access(chromium.executablePath());
console.log(`Verified Playwright ${version} full Chromium at ${chromium.executablePath()}`);
