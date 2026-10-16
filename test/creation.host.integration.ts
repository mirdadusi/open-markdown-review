import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { creationSetup } from './creation.extension.integration';
import packageJson from '../package.json';

/** Focused real extension-host qualification; no Slidev author runtime needed. */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension(`${packageJson.publisher}.${packageJson.name}`); assert.ok(extension);
  await extension.activate(); assert.ok(extension.isActive);
  await creationSetup(extension.extensionPath, await mkdtemp(path.join(os.tmpdir(), 'omr-creation-host-')));
}
