/** Optional transport bytes, never protocol evidence and never auto-executed. */
import { COMPANION_TARGETS } from './companionTargets';
/** Historical sidecars stay recognizable for transport and recoverable upgrades only. */
export const COMPANION_SIDECARS: readonly string[] = ['StartReview.exe.sha256', 'StartReview.sha256', 'build.json', 'THIRD-PARTY-NOTICES.txt', ...COMPANION_TARGETS.flatMap(target => [`${target.filename}.sha256`, `${target.filename}.build.json`, `${target.filename}.NOTICES.txt`])];
export const COMPANION_ARTIFACTS: readonly string[] = ['StartReview.exe', 'StartReview', 'START-HERE.txt', 'LICENSE', ...COMPANION_TARGETS.map(target => target.filename), ...COMPANION_SIDECARS];
