import fs from 'fs-extra';
import os from 'os';
import path from 'path';

const tempDirs = new Set<string>();
let cleanupRegistered = false;

const registerCleanup = (): void => {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.once('exit', () => {
    for (const dir of tempDirs) {
      try {
        fs.removeSync(dir);
      } catch {
        // best-effort cleanup
      }
    }
    tempDirs.clear();
  });
};

export const createTempDir = (): string => {
  registerCleanup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fhir-package-installer-test-'));
  tempDirs.add(dir);
  return dir;
};
