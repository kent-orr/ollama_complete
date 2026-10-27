import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');
  const workspace = path.resolve(extensionDevelopmentPath, 'fixtures');
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspace, '--disable-extensions'],
  });
}

main().catch((err) => {
  console.error('Integration tests failed', err);
  process.exit(1);
});
