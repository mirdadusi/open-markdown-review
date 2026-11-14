import MarkdownIt from 'markdown-it';
import { ascii, safePath } from './bytes';
import { attribute, scanHtml } from './html';
import { LIMITS, ProtocolError, Sha256Digest } from './types';

export interface FindingDocumentLink { document: string; reference: string; target?: string; problem?: string }
export interface FindingScopePlan {
  kind: 'finding-scope-v1'; digest: Sha256Digest; originRevisionId: string; parents: string[];
  reviewTitle: string; sourceRoot: string; destination: string; rootDocument: string;
  documents: Array<{ path: string; inReview: boolean; available: boolean; digest?: Sha256Digest; referencedBy: string[] }>;
  links: FindingDocumentLink[];
}
export interface FindingScopeChoice { planDigest: Sha256Digest; documents: string[]; parents: string[] }
export function findingScopeChoice(value: unknown): FindingScopeChoice {
  const choice = value as FindingScopeChoice;
  if (!choice || typeof choice !== 'object' || !/^sha256:[a-f0-9]{64}$/.test(choice.planDigest) || !Array.isArray(choice.documents) || !choice.documents.length || choice.documents.length > LIMITS.documents || !Array.isArray(choice.parents) || !choice.parents.length || choice.parents.length > LIMITS.revisions || [...choice.documents, ...choice.parents].some(item => typeof item !== 'string') || new Set(choice.documents).size !== choice.documents.length || new Set(choice.parents).size !== choice.parents.length) throw new ProtocolError('invalid', 'Confirm a valid document scope and its original publication parents.');
  choice.documents.forEach(safePath);
  return { planDigest: choice.planDigest, documents: [...choice.documents].sort(ascii), parents: [...choice.parents] };
}

/** Local Markdown navigation only. Never follows an external URL or attachment. */
export function markdownDocumentLinks(source: string, document: string, html = true): FindingDocumentLink[] {
  const parser = new MarkdownIt({ html }), found = new Map<string, FindingDocumentLink>();
  const add = (reference: string) => {
    if (!reference || /^(?:[A-Za-z][A-Za-z\d+.-]*:|\/\/|\\\\)/.test(reference)) return;
    const raw = reference.split(/[?#]/, 1)[0]; if (!raw) return;
    let decoded: string;
    try { decoded = decodeURIComponent(raw); } catch { if (/\.md$/i.test(raw)) found.set(reference, { document, reference, problem: 'Malformed percent encoding in Markdown link.' }); return; }
    if (!/\.md$/i.test(decoded)) return;
    try {
      if (/^[\\/]/.test(decoded) || decoded.includes('\\')) throw new Error('Use a relative Markdown link with forward slashes.');
      const parts = document.split('/').slice(0, -1);
      for (const part of decoded.split('/')) {
        if (part === '..') { if (!parts.length) throw new Error('Markdown link escapes the source root.'); parts.pop(); }
        else if (part && part !== '.') parts.push(part);
      }
      const target = safePath(parts.join('/'));
      const base = `https://review.invalid/${document.split('/').map(encodeURIComponent).join('/')}`;
      if (decodeURIComponent(new URL(reference, base).pathname.slice(1)) !== target) throw new Error('Normalize the Markdown link path; it would navigate to a different frozen path.');
      found.set(reference, { document, reference, target });
    } catch (error) { found.set(reference, { document, reference, problem: error instanceof Error ? error.message : String(error) }); }
  };
  const htmlLinks = (fragment: string) => { for (const part of scanHtml(fragment)) if (part.kind === 'tag' && part.name === 'a' && !part.closing && attribute(part, 'title')?.trim().toLowerCase() !== 'review:attach') add(parser.utils.unescapeAll(attribute(part, 'href') ?? '')); };
  for (const token of parser.parse(source, {})) {
    if (html && token.type === 'html_block') htmlLinks(token.content);
    for (const child of token.children ?? []) {
      if (child.type === 'link_open' && child.attrGet('title')?.trim().toLowerCase() !== 'review:attach') add(child.attrGet('href') ?? '');
      if (html && child.type === 'html_inline') htmlLinks(child.content);
    }
  }
  return [...found.values()];
}

export function findingScopeProblems(plan: FindingScopePlan, paths: readonly string[]): string[] {
  const selected = new Set(paths), documents = new Map(plan.documents.map(item => [item.path, item])), problems: string[] = [];
  if (!selected.size || selected.size > LIMITS.documents) problems.push(`Select between 1 and ${LIMITS.documents} Markdown files.`);
  if (!selected.has(plan.rootDocument)) problems.push('Keep the review root document in scope.');
  for (const file of selected) if (!documents.get(file)?.available) problems.push(`${file}: source Markdown file is missing or unavailable.`);
  for (const link of plan.links) if (selected.has(link.document)) {
    if (link.problem) problems.push(`${link.document} → ${link.reference}: ${link.problem}`);
    else if (link.target && !selected.has(link.target)) problems.push(`${link.document} → ${link.target}: include the linked Markdown file or update/remove this link in the source.`);
  }
  return [...new Set(problems)];
}
