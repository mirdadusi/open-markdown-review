// Publication classification is separate from professional-pilot qualification.
export function releasePolicy(pkg, qualification, publication = false) {
  if (qualification.schemaVersion !== 'omr-release-qualification/1'
      || qualification.version !== pkg.version
      || !/^\d+\.\d+\.\d+$/.test(pkg.version)
      || typeof qualification.professionalPilotApproved !== 'boolean'
      || !Array.isArray(qualification.blockingGates)
      || qualification.blockingGates.some(gate => typeof gate !== 'string' || !gate.trim())) {
    throw new Error('Invalid or version-mismatched release qualification record.');
  }
  const channel = publication ? (qualification.publication?.channel ?? 'professional') : 'professional';
  if (channel === 'evaluation' || channel === 'standard') {
    const approval = qualification.publication;
    if (approval.approved !== true || approval.approvedBy !== 'user'
        || !/^\d{4}-\d{2}-\d{2}$/.test(approval.approvedOn ?? '')) {
      throw new Error('Evaluation or standard publication requires explicit recorded user approval.');
    }
  } else if (channel === 'professional') {
    if (qualification.professionalPilotApproved !== true || qualification.blockingGates.length) {
      throw new Error(`Professional pilot release is not approved for ${pkg.version}. See ${qualification.statusReport}.`);
    }
  } else {
    throw new Error(`Unknown release channel: ${channel}`);
  }
  return {
    channel,
    prerelease: channel === 'evaluation',
    notesFile: `docs/releases/${pkg.version}.md`,
  };
}

export function vsixChannelArgs(channel = 'professional') {
  if (channel === 'evaluation') return ['--pre-release'];
  if (channel === 'professional' || channel === 'standard') return [];
  throw new Error(`Unknown VSIX release channel: ${channel}`);
}

/** Keep qualification details in their report, without prescribing a release-note sentence. */
export function verifyReleaseNotes(notes, policy, qualification) {
  if (typeof notes !== 'string' || !notes.trim()) throw new Error('Release notes must not be empty.');
  if (policy.prerelease && !/evaluation pre-release/i.test(notes)) throw new Error('Evaluation release notes must identify the pre-release channel.');
  if (!qualification.professionalPilotApproved && (typeof qualification.statusReport !== 'string' || !qualification.statusReport.trim() || !notes.includes(qualification.statusReport))) {
    throw new Error('Release notes must reference the qualification report.');
  }
}
