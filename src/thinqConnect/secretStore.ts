import { constants as fsConstants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PAT_FILENAME = 'pat';
const RETRY_DELAYS_MS = [40, 100, 250, 500];

export type PatStoreStatus = {
  configured: boolean;
  externallyManaged: boolean;
  location: string;
};

export type PatValidator = (pat: string) => Promise<void>;

function cleanPat(value: string): string {
  const pat = value.trim();
  if (!pat || /[\r\n\0]/u.test(pat)) {
    throw new Error('The ThinQ Connect PAT is empty or malformed.');
  }
  return pat;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function assertRegularFile(filePath: string): Promise<void> {
  const stats = await fs.lstat(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error('The ThinQ Connect PAT path must be a regular file, not a link or directory.');
  }
}

async function assertSafeDirectory(directory: string, create: boolean): Promise<void> {
  if (create) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const stats = await fs.lstat(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error('The ThinQ Connect secret location must be a real directory.');
  }
  if (process.platform !== 'win32') {
    await fs.chmod(directory, 0o700);
  }
}

function defaultSecretDirectory(storagePath?: string): string {
  const homebridgePath = storagePath || path.join(os.homedir(), '.homebridge');
  return path.join(homebridgePath, '.lg-thinq-connect');
}

export class PatSecretStore {
  public readonly externallyManaged: boolean;
  public readonly filePath: string;
  private operation: Promise<unknown> = Promise.resolve();

  constructor(storagePath?: string, env: NodeJS.ProcessEnv = process.env) {
    const externalPath = env.LG_THINQ_PAT_FILE?.trim();
    this.externallyManaged = Boolean(externalPath);
    this.filePath = externalPath
      ? path.resolve(externalPath!)
      : path.join(path.resolve(env.LG_THINQ_SECRET_DIR?.trim() || defaultSecretDirectory(storagePath)), PAT_FILENAME);
  }

  public async status(): Promise<PatStoreStatus> {
    let configured = false;
    try {
      await assertRegularFile(this.filePath);
      await fs.access(this.filePath, fsConstants.R_OK);
      configured = Boolean(cleanPat(await fs.readFile(this.filePath, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    return {
      configured,
      externallyManaged: this.externallyManaged,
      location: this.filePath,
    };
  }

  public async read(): Promise<string> {
    await assertRegularFile(this.filePath);
    return cleanPat(await fs.readFile(this.filePath, 'utf8'));
  }

  public async install(candidate: string, validate: PatValidator): Promise<void> {
    if (this.externallyManaged) {
      throw new Error('The ThinQ Connect PAT is externally managed and cannot be replaced here.');
    }
    const pat = cleanPat(candidate);
    await this.serialized(async () => {
      await validate(pat);
      const directory = path.dirname(this.filePath);
      await assertSafeDirectory(directory, true);
      try {
        await assertRegularFile(this.filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }

      const temporary = path.join(directory, `.${PAT_FILENAME}.${process.pid}.${Date.now()}.tmp`);
      try {
        await fs.writeFile(temporary, `${pat}\n`, { mode: 0o600, flag: 'wx' });
        if (process.platform !== 'win32') {
          await fs.chmod(temporary, 0o600);
        }
        await this.renameWithRetry(temporary, this.filePath);
      } finally {
        await fs.rm(temporary, { force: true });
      }
    });
  }

  public async remove(): Promise<void> {
    if (this.externallyManaged) {
      throw new Error('The ThinQ Connect PAT is externally managed and cannot be removed here.');
    }
    await this.serialized(async () => {
      try {
        await assertRegularFile(this.filePath);
        await fs.unlink(this.filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    });
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  private async renameWithRetry(source: string, destination: string): Promise<void> {
    if (process.platform === 'win32') {
      await this.replaceOnWindows(source, destination);
      return;
    }
    let lastError: unknown;
    for (const wait of [0, ...RETRY_DELAYS_MS]) {
      if (wait) {
        await delay(wait);
      }
      try {
        await fs.rename(source, destination);
        return;
      } catch (error) {
        lastError = error;
        const code = (error as NodeJS.ErrnoException).code;
        if (!['EACCES', 'EBUSY', 'EPERM'].includes(code || '')) {
          throw error;
        }
      }
    }
    throw lastError;
  }

  private async replaceOnWindows(source: string, destination: string): Promise<void> {
    const backup = `${destination}.${process.pid}.previous`;
    let hadPrevious = false;
    try {
      try {
        await this.retryWindowsRename(destination, backup);
        hadPrevious = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
      await this.retryWindowsRename(source, destination);
      if (hadPrevious) {
        await fs.rm(backup, { force: true });
      }
    } catch (error) {
      if (hadPrevious) {
        try {
          await this.retryWindowsRename(backup, destination);
        } catch {
          throw new Error('PAT replacement failed and the previous credential could not be restored safely.', { cause: error });
        }
      }
      throw error;
    }
  }

  private async retryWindowsRename(source: string, destination: string): Promise<void> {
    let lastError: unknown;
    for (const wait of [0, ...RETRY_DELAYS_MS]) {
      if (wait) {
        await delay(wait);
      }
      try {
        await fs.rename(source, destination);
        return;
      } catch (error) {
        lastError = error;
        const code = (error as NodeJS.ErrnoException).code;
        if (!['EACCES', 'EBUSY', 'EPERM'].includes(code || '')) {
          throw error;
        }
      }
    }
    throw lastError;
  }
}
