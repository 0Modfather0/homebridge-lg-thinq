import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PatSecretStore } from './secretStore.js';

const temporary: string[] = [];

async function directory(): Promise<string> {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-thinq-connect-'));
  temporary.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(value => fs.rm(value, { recursive: true, force: true })));
});

describe('PAT secret store', () => {
  test('validates before writing and never overwrites a valid PAT after validation failure', async () => {
    const root = await directory();
    const store = new PatSecretStore(root, {});
    await store.install('valid-pat', async () => undefined);
    await expect(store.install('bad-pat', async () => {
      throw new Error('revoked');
    })).rejects.toThrow('revoked');
    expect(await store.read()).toBe('valid-pat');
    expect((await store.status()).configured).toBe(true);
    if (process.platform !== 'win32') {
      expect((await fs.stat(store.filePath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.dirname(store.filePath))).mode & 0o777).toBe(0o700);
    }
  });

  test('serializes concurrent replacements', async () => {
    const root = await directory();
    const store = new PatSecretStore(root, {});
    const validator = jest.fn(async () => undefined);
    await Promise.all([store.install('one', validator), store.install('two', validator)]);
    expect(await store.read()).toBe('two');
    expect(validator).toHaveBeenCalledTimes(2);
  });

  test('rejects linked targets and external mutation', async () => {
    const root = await directory();
    const target = path.join(root, 'external-pat');
    await fs.writeFile(target, 'external');
    const external = new PatSecretStore(root, { LG_THINQ_PAT_FILE: target });
    await expect(external.install('replacement', async () => undefined)).rejects.toThrow('externally managed');
    await expect(external.remove()).rejects.toThrow('externally managed');

    if (process.platform !== 'win32') {
      const managedDirectory = path.join(root, 'managed');
      await fs.mkdir(managedDirectory);
      await fs.symlink(target, path.join(managedDirectory, 'pat'));
      const linked = new PatSecretStore(root, { LG_THINQ_SECRET_DIR: managedDirectory });
      await expect(linked.read()).rejects.toThrow('regular file');
    }
  });
});
