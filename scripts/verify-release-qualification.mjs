import { appendFile, readFile } from 'node:fs/promises';
import { releasePolicy } from './release-policy.mjs';
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--publication')) {
  throw new Error('Usage: node scripts/verify-release-qualification.mjs [--publication]');
}
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const qualification = JSON.parse(await readFile('release-qualification.json', 'utf8'));
const policy = releasePolicy(pkg, qualification, args[0] === '--publication');
if (args[0] === '--publication') {
  const notes = await readFile(policy.notesFile, 'utf8');
  if (!notes.trim() || (policy.prerelease && !/evaluation pre-release/i.test(notes))) {
    throw new Error('Release notes must exist and disclose evaluation pre-release status.');
  }
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `channel=${policy.channel}\nprerelease=${policy.prerelease}\nnotes-file=${policy.notesFile}\n`);
  }
}
console.log(`Authorized ${policy.channel} publication for ${pkg.version}; professional-pilot approval: ${qualification.professionalPilotApproved}.`);
