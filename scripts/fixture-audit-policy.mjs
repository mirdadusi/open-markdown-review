import { createHash } from 'node:crypto';

/** Only the explicitly trusted, isolated author fixture; never client audits. */
export function verifyFixtureAudit({ audit, policy, lockBytes, today = new Date().toISOString().slice(0, 10) }) {
  if (audit?.error || !audit?.vulnerabilities || !audit?.metadata?.vulnerabilities) throw new Error('Slidev fixture dependency audit is unavailable.');
  const counts = audit.metadata.vulnerabilities;
  if (!Number.isInteger(counts.high) || !Number.isInteger(counts.critical) || counts.critical !== 0 || counts.high !== Object.values(audit.vulnerabilities).filter(entry => entry.severity === 'high').length) throw new Error('Incomplete or critical Slidev fixture audit.');
  if (policy?.schemaVersion === 'omr-fixture-audit-policy/3') {
    if (!Array.isArray(policy.exceptions) || policy.exceptions.length || policy.advisories !== undefined || policy.reviewAfter !== undefined) throw new Error('The current fixture policy permits no advisory exceptions.');
    if (policy.lockDigest !== `sha256:${createHash('sha256').update(lockBytes).digest('hex')}`) throw new Error('The isolated author-fixture lockfile differs from the reviewed dependency graph.');
    if (counts.high !== 0 || Object.values(audit.vulnerabilities).some(entry => ['high', 'critical'].includes(entry.severity))) throw new Error('The isolated author fixture has an unaccepted high/critical vulnerability.');
    return [];
  }
  const dates = [policy?.reviewedOn, policy?.reviewAfter, today];
  if (dates.some(value => typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw new Error('Invalid fixture advisory review date.');
  const approved = Date.parse(policy.reviewedOn), expires = Date.parse(policy.reviewAfter), now = Date.parse(today);
  if (policy?.schemaVersion !== 'omr-fixture-audit-policy/2' || policy.approval !== 'explicit-project-owner-approval' || !Number.isFinite(approved) || !Number.isFinite(expires) || !Number.isFinite(now) || expires <= approved || expires - approved > 30 * 86400000 || now < approved || now > expires) throw new Error('The isolated author-fixture audit exceptions require review (maximum 30 days).');
  if (policy.lockDigest !== `sha256:${createHash('sha256').update(lockBytes).digest('hex')}`) throw new Error('The isolated author-fixture lockfile differs from the reviewed dependency graph.');
  const lock = JSON.parse(lockBytes.toString('utf8')), accepted = [];
  const advisory = 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm';
  if (policy.advisories?.length !== 1 || policy.advisories[0] !== advisory) throw new Error('Only the explicitly approved braces advisory may be excepted.');
  for (const [name, entry] of Object.entries(audit.vulnerabilities)) {
    if (!['high', 'critical'].includes(entry.severity)) continue;
    if (entry.severity !== 'high' || !Array.isArray(entry.nodes) || !entry.nodes.length || !Array.isArray(entry.via) || !entry.via.length || entry.nodes.some(node => typeof node !== 'string' || node.slice(node.lastIndexOf('node_modules/') + 'node_modules/'.length) !== name || !policy.reviewedNodes?.[node] || lock.packages?.[node]?.version !== policy.reviewedNodes[node])) throw new Error(`Unaccepted Slidev author-fixture vulnerability: ${name}`);
    for (const via of entry.via) {
      if (typeof via === 'string') {
        if (!audit.vulnerabilities[via]) throw new Error(`Incomplete fixture advisory propagation: ${name}`);
      } else if (via.url !== advisory || via.name !== 'braces' || via.severity !== 'high') throw new Error(`Unaccepted Slidev author-fixture advisory: ${via.url}`);
    }
    accepted.push(name);
  }
  return accepted.sort();
}
