import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
await mkdir('coverage', { recursive: true });
const result = spawnSync(process.execPath, ['--test', '--experimental-test-coverage', '--test-coverage-include=out/src/professional/**', '--test-coverage-exclude=**/generated/**', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=lcov', '--test-reporter-destination=coverage/native-core.lcov', 'out/test/professional.test.js'], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
