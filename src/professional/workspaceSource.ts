import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { mapWithConcurrency } from '../protocol/concurrency';
import { reviewPathKey } from '../reviewPaths';
import { contained } from './nativeStorage';
import { checkpoint, interruptible, OperationControl } from './operation';
import { ProtocolError } from './types';
import { SourceBindingCheck, SourceBindingSnapshot, inspectSourceCandidate, sourceBindingSnapshot, sourceWithin } from './sourceBinding';

export interface SourceWorkspace { name: string; root: string }
export interface WorkspaceSourceCandidate {
  name: string; inputRoot: string; workspaceRoot: string;
  kind: 'workspace' | 'active-document'; report: SourceBindingCheck;
}
export interface SourceDiscovery {
  candidates: WorkspaceSourceCandidate[];
  issues: Array<{ root: string; message: string }>;
  truncated: boolean;
  unverified: boolean;
}
export const MAX_SOURCE_CANDIDATES = 64;
export interface SourceLinkUi {
  confirm(snapshot: SourceBindingSnapshot, report: SourceBindingCheck, candidate?: WorkspaceSourceCandidate, singleWorkspace?: boolean): Promise<'use' | 'browse' | undefined>;
  pick(snapshot: SourceBindingSnapshot, discovery: SourceDiscovery): Promise<WorkspaceSourceCandidate | 'browse' | undefined>;
  browse(snapshot: SourceBindingSnapshot, defaultRoot: string | undefined, discovery: SourceDiscovery): Promise<string | undefined>;
  missing(report: SourceBindingCheck): Promise<'browse' | undefined>;
}
export interface SourceLinkOptions extends OperationControl {
  reviewRoot: string; expectedReviewId?: string; journalRoot: string; previousSource?: string;
  workspaces(): SourceWorkspace[]; activeDocument?: string; ui: SourceLinkUi;
  /** Only a user-invoked source action may reuse one unambiguous match. */
  reuseSingleMatch?: boolean;
}

/** No repository-wide search or basename remapping. Only declared roots and a
 * bounded suffix hint from the user's active native Markdown document. */
export async function discoverWorkspaceSources(snapshot: SourceBindingSnapshot, workspaces: readonly SourceWorkspace[], journalRoot: string,
  activeDocument?: string, control?: OperationControl): Promise<SourceDiscovery> {
  const result: SourceDiscovery = { candidates: [], issues: [], truncated: false, unverified: false };
  const proposals = new Map<string, Omit<WorkspaceSourceCandidate, 'report'>>();
  const add = (item: Omit<WorkspaceSourceCandidate, 'report'>) => {
    const key = reviewPathKey(item.inputRoot); if (proposals.has(key)) return;
    if (proposals.size >= MAX_SOURCE_CANDIDATES) { result.truncated = true; return; }
    proposals.set(key, item);
  };
  for (const workspace of workspaces) {
    checkpoint(control);
    if (!path.isAbsolute(workspace.root)) { result.issues.push({ root: workspace.root, message: 'Not a native absolute source folder.' }); continue; }
    add({ name: workspace.name, inputRoot: workspace.root, workspaceRoot: workspace.root, kind: 'workspace' });
    if (!activeDocument || !path.isAbsolute(activeDocument) || !sourceWithin(workspace.root, activeDocument)) continue;
    for (const document of snapshot.documents) {
      let root = activeDocument; for (const _part of document.path.split('/')) root = path.dirname(root);
      if (!sourceWithin(workspace.root, root) || reviewPathKey(root) === reviewPathKey(workspace.root)) continue;
      const relative = path.relative(root, activeDocument).split(path.sep).join('/');
      if ((process.platform === 'win32' ? relative.toLowerCase() : relative) !== (process.platform === 'win32' ? document.path.toLowerCase() : document.path)) continue;
      add({ name: `${workspace.name} / ${path.relative(workspace.root, root)}`, inputRoot: root, workspaceRoot: workspace.root, kind: 'active-document' });
    }
  }
  const canonical = new Set<string>();
  const checked = new Map<string, Promise<SourceBindingCheck>>();
  for (const candidate of await mapWithConcurrency([...proposals.values()], 4, async proposal => {
    try {
      checkpoint(control);
      if (proposal.kind === 'active-document') {
        // Never use an editor hint to traverse a linked folder out of a workspace.
        await interruptible(contained(proposal.workspaceRoot, path.relative(proposal.workspaceRoot, proposal.inputRoot).split(path.sep).join('/')), control);
        const workspace = await interruptible(realpath(proposal.workspaceRoot), control);
        if (!sourceWithin(workspace, await interruptible(realpath(proposal.inputRoot), control))) throw new ProtocolError('permission', 'Suggested source escapes the open workspace.');
      }
      const canonicalRoot = await interruptible(realpath(proposal.inputRoot), control), key = reviewPathKey(canonicalRoot);
      let check = checked.get(key);
      if (!check) { check = inspectSourceCandidate(snapshot, canonicalRoot, journalRoot, control); checked.set(key, check); }
      const report = await check;
      if (report.missing.length) { result.issues.push({ root: proposal.inputRoot, message: `${report.missing.length} reviewed path(s) missing, including ${report.missing.slice(0, 3).join(', ')}` }); return; }
      return { ...proposal, report };
    } catch (error) {
      checkpoint(control);
      if (error instanceof ProtocolError && error.code === 'cancelled') throw error;
      // A locked/offline/changed root is not proof of a non-match. Do not infer
      // that the other successful root is the only possible editable copy.
      const code = error instanceof ProtocolError ? error.code : (error as NodeJS.ErrnoException).code;
      if (!['missing', 'invalid', 'integrity', 'unsupported', 'ENOENT', 'ENOTDIR'].includes(code ?? '')) result.unverified = true;
      result.issues.push({ root: proposal.inputRoot, message: error instanceof Error ? error.message : String(error) });
    }
  })) {
    if (!candidate) continue;
    const key = reviewPathKey(candidate.report.sourceRoot);
    if (!canonical.has(key)) { canonical.add(key); result.candidates.push(candidate); }
  }
  checkpoint(control);
  return result;
}

/** Returns a freshly revalidated private binding, either explicitly confirmed
 * or reused for a source action from exactly one fully checked workspace. It
 * never writes a source, review, participant record or VS Code memento. */
export async function chooseSourceWorkspace(options: SourceLinkOptions): Promise<{ reviewId: string; report: SourceBindingCheck; automatic: boolean } | undefined> {
  const snapshot = await sourceBindingSnapshot(options.reviewRoot, options.journalRoot, options);
  if (options.expectedReviewId && snapshot.reviewId !== options.expectedReviewId) throw new ProtocolError('changed', 'This folder now contains a different review. Reconnect it before linking source.');
  const workspaces = options.workspaces();
  const workspaceSet = (roots: SourceWorkspace[]) => [...new Set(roots.map(root => reviewPathKey(root.root)))].sort().join('\0');
  const initialWorkspaceSet = workspaceSet(workspaces);
  const discovery = await discoverWorkspaceSources(snapshot, workspaces, options.journalRoot, options.activeDocument, options);
  const automatic = options.reuseSingleMatch === true && !options.previousSource && discovery.candidates.length === 1 && !discovery.truncated && !discovery.unverified;
  checkpoint(options, automatic ? 'Using the verified workspace match; rechecking before saving a private link…' : 'Choose the source folder in the picker; no source link has been saved.');
  let candidate: WorkspaceSourceCandidate | undefined, inputRoot: string | undefined, report: SourceBindingCheck | undefined;
  let browse = !discovery.candidates.length;
  if (discovery.candidates.length === 1 && !discovery.truncated) {
    candidate = discovery.candidates[0];
    const action = automatic ? 'use' : await options.ui.confirm(snapshot, candidate.report, candidate, workspaces.length === 1); checkpoint(options);
    if (!action) return;
    if (action === 'use') { inputRoot = candidate.inputRoot; report = candidate.report; }
    else { browse = true; candidate = undefined; }
  } else if (discovery.candidates.length) {
    const selected = await options.ui.pick(snapshot, discovery); checkpoint(options);
    if (!selected) return;
    if (selected === 'browse') browse = true;
    else {
      candidate = discovery.candidates.find(c => c.inputRoot === selected.inputRoot);
      if (!candidate) throw new ProtocolError('invalid', 'Choose one of the checked workspace folders.');
      inputRoot = candidate.inputRoot; report = candidate.report;
    }
  }
  while (browse) {
    inputRoot = await options.ui.browse(snapshot, options.previousSource ?? workspaces[0]?.root, discovery); checkpoint(options);
    if (!inputRoot) return;
    report = await inspectSourceCandidate(snapshot, inputRoot, options.journalRoot, options);
    if (report.missing.length) {
      if (await options.ui.missing(report) !== 'browse') return;
      continue;
    }
    const action = await options.ui.confirm(snapshot, report); checkpoint(options);
    if (!action) return;
    browse = action === 'browse';
  }
  if (!inputRoot || !report) return;
  checkpoint(options, 'Rechecking review and source before saving the private link…');
  if (candidate && !options.workspaces().some(w => reviewPathKey(w.root) === reviewPathKey(candidate!.workspaceRoot))) throw new ProtocolError('changed', 'The selected workspace folder was closed or replaced. Try linking again.');
  const fresh = await sourceBindingSnapshot(options.reviewRoot, options.journalRoot, options);
  if (fresh.fingerprint !== snapshot.fingerprint) throw new ProtocolError('changed', 'The reviewed document scope or revision heads changed while choosing source. No binding was changed; try again.');
  const checked = await inspectSourceCandidate(fresh, inputRoot, options.journalRoot, options);
  if (checked.missing.length || checked.fingerprint !== report.fingerprint) throw new ProtocolError('changed', 'The source files or folder changed during confirmation. No binding was changed; inspect and try again.');
  if (automatic && workspaceSet(options.workspaces()) !== initialWorkspaceSet) throw new ProtocolError('changed', 'The open workspace folders changed during source discovery. No source link was saved; try again.');
  if (candidate && !options.workspaces().some(w => reviewPathKey(w.root) === reviewPathKey(candidate!.workspaceRoot))) throw new ProtocolError('changed', 'The selected workspace folder was closed or replaced. Try linking again.');
  checkpoint(options);
  return { reviewId: fresh.reviewId, report: checked, automatic };
}
