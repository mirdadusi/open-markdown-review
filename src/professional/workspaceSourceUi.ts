import * as vscode from 'vscode';
import { SourceLinkUi, SourceWorkspace } from './workspaceSource';
import type { SourceBindingReport } from './sourceBinding';

/** Only disk providers owned by this extension host are native source roots. */
export function nativeSourceUri(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' || uri.scheme === 'vscode-remote' && !!vscode.env.remoteName && uri.authority.split('+')[0] === vscode.env.remoteName;
}
export function openSourceWorkspaces(): SourceWorkspace[] {
  return (vscode.workspace.workspaceFolders ?? []).filter(folder => nativeSourceUri(folder.uri)).map(folder => ({ name: folder.name, root: folder.uri.fsPath }));
}
const summary = (report: SourceBindingReport) => `${report.exact.length} unchanged, ${report.changed.length} with saved changes, ${report.missing.length} missing (${report.documents} reviewed Markdown files). Changed source is expected when addressing findings.`;
async function sourceQuickPick<T extends vscode.QuickPickItem>(items: T[], options: vscode.QuickPickOptions, signal?: AbortSignal): Promise<T | undefined> {
  const cancellation = new vscode.CancellationTokenSource(), abort = () => cancellation.cancel();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) cancellation.cancel();
  try { return await vscode.window.showQuickPick(items, options, cancellation.token); }
  finally { signal?.removeEventListener('abort', abort); cancellation.dispose(); }
}
export function workspaceSourceUi(signal?: AbortSignal): SourceLinkUi {
  return {
    confirm: async (snapshot, report, candidate, singleWorkspace) => {
      const action = candidate?.kind === 'workspace' ? singleWorkspace ? 'Use current workspace' : 'Use this workspace folder' : candidate ? 'Use source folder' : 'Use selected folder';
      const browse = 'Choose another folder…';
      const result = await sourceQuickPick([
        { label: action, description: report.sourceRoot, detail: `${candidate?.kind === 'active-document' ? 'Suggested from active document. ' : ''}${summary(report)}`, action: 'use' as const },
        { label: browse, description: 'Inspect a different editable source root', action: 'browse' as const }
      ], { title: `Link editable source to “${snapshot.title}”`, placeHolder: 'Save a private link only. Source and shared review stay unchanged.', ignoreFocusOut: true }, signal);
      return result?.action;
    },
    pick: async (snapshot, discovery) => {
      const chosen = await sourceQuickPick([
        ...discovery.candidates.map(candidate => ({ label: `Use ${candidate.name}`, description: candidate.report.sourceRoot, detail: summary(candidate.report), candidate })),
        { label: 'Choose another folder…', description: discovery.truncated ? 'Workspace discovery reached its bounded candidate limit; choose the source explicitly.' : 'Select a source outside the checked folders', candidate: undefined }
      ], { title: `Link source for “${snapshot.title}”`, placeHolder: 'Multiple source folders can match. Choose explicitly; only a private source link is saved.', ignoreFocusOut: true }, signal);
      return !chosen ? undefined : chosen.candidate ?? 'browse';
    },
    browse: async (snapshot, defaultRoot, discovery) => (await vscode.window.showOpenDialog({
      title: `${discovery.candidates.length ? 'Choose another source folder' : 'No verified workspace match; choose source'} for “${snapshot.title}”`,
      defaultUri: defaultRoot ? vscode.Uri.file(defaultRoot) : undefined, canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Inspect source folder'
    }))?.[0]?.fsPath,
    missing: async report => {
      const action = 'Choose another folder…';
      const result = await vscode.window.showErrorMessage(`The selected folder is missing ${report.missing.length} reviewed Markdown paths.`, { modal: true,
        detail: `${report.sourceRoot}\n\n${report.missing.slice(0, 12).join('\n')}${report.missing.length > 12 ? '\n…' : ''}\n\nPaths must match relative to the source root. Merely having the same filenames in other subfolders is not sufficient.` }, action);
      return result === action ? 'browse' : undefined;
    }
  };
}
