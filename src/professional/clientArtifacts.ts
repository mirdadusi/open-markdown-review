/** Optional transport bytes, never protocol evidence and never auto-executed. */
import { COMPANION_TARGETS } from './companionTargets';
export const COMPANION_ARTIFACTS: readonly string[] = ['StartReview.exe', 'StartReview', 'StartReview.exe.sha256', 'StartReview.sha256', 'START-HERE.txt', 'THIRD-PARTY-NOTICES.txt', 'LICENSE', 'build.json', ...COMPANION_TARGETS.flatMap(target => [target.filename, `${target.filename}.sha256`, `${target.filename}.build.json`, `${target.filename}.NOTICES.txt`])];
