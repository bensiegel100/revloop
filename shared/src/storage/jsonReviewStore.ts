import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import type { BranchReviewState, RepositoryIdentity } from "../domain/types.js";
import { branchStateSchemaVersion } from "../domain/types.js";
import { sha256 } from "../platform/hash.js";
import { parseBranchReviewState } from "./schema.js";

const defaultLockTimeoutMs = 5_000;
const defaultLockRetryDelayMs = 10;
const lockOwnerFileName = "owner.json";
const branchStateFileNamePattern = /^[a-f0-9]{64}\.json$/u;

interface JsonReviewStoreOptions {
  lockTimeoutMs?: number;
  lockRetryDelayMs?: number;
}

interface LockOwner {
  token: string;
  pid: number;
  hostname: string;
  createdAt: string;
}

export class ConcurrentReviewStateError extends Error {
  public constructor(filePath: string) {
    super(`Review state changed in another VS Code window: ${filePath}`);
    this.name = "ConcurrentReviewStateError";
  }
}

export class JsonReviewStore {
  private readonly lockTimeoutMs: number;
  private readonly lockRetryDelayMs: number;

  public constructor(
    private readonly legacyStorageRoot?: string,
    options: JsonReviewStoreOptions = {},
  ) {
    this.lockTimeoutMs = options.lockTimeoutMs ?? defaultLockTimeoutMs;
    this.lockRetryDelayMs = options.lockRetryDelayMs ?? defaultLockRetryDelayMs;
  }

  public async loadBranch(
    repository: RepositoryIdentity,
    branch: string,
  ): Promise<BranchReviewState> {
    const filePath = this.branchFile(repository, branch);
    const raw = await this.readJson(filePath);
    if (raw === undefined) {
      const legacy = await this.loadLegacyBranch(repository, branch);
      if (legacy !== undefined) {
        return this.withBranchLock(filePath, async () => {
          const current = await this.readJson(filePath);
          if (current !== undefined) {
            return this.parseBranchState(current, repository);
          }

          await this.atomicWrite(filePath, legacy);
          return legacy;
        });
      }

      const now = new Date().toISOString();
      return {
        schemaVersion: branchStateSchemaVersion,
        revision: 0,
        repository,
        branch,
        threads: [],
        createdAt: now,
        updatedAt: now,
      };
    }

    return this.parseBranchState(raw, repository);
  }

  public async saveBranch(
    state: BranchReviewState,
    expectedRevision: number,
  ): Promise<BranchReviewState> {
    const filePath = this.branchFile(state.repository, state.branch);
    return this.withBranchLock(filePath, async () => {
      const current = await this.readJson(filePath);
      if (current !== undefined) {
        const parsed = parseBranchReviewState(current, state.repository);
        if (parsed.revision !== expectedRevision) {
          throw new ConcurrentReviewStateError(filePath);
        }
      } else if (expectedRevision !== 0) {
        throw new ConcurrentReviewStateError(filePath);
      }

      const next: BranchReviewState = {
        ...state,
        revision: expectedRevision + 1,
        updatedAt: new Date().toISOString(),
      };

      await this.atomicWrite(filePath, next);
      return next;
    });
  }

  public async pruneBranchStates(
    repository: RepositoryIdentity,
    retainedBranches: readonly string[],
  ): Promise<void> {
    const directory = path.join(repository.storageRoot, "branches");
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error: unknown) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return;
      }
      throw error;
    }

    const retainedFiles = new Set(
      retainedBranches.map((branch) => `${sha256(branch)}.json`),
    );
    for (const entry of entries) {
      if (!branchStateFileNamePattern.test(entry) || retainedFiles.has(entry)) {
        continue;
      }

      const filePath = path.join(directory, entry);
      await this.withBranchLock(filePath, async () => {
        await rm(filePath, { force: true });
      });
    }
  }

  private branchFile(repository: RepositoryIdentity, branch: string): string {
    return path.join(
      repository.storageRoot,
      "branches",
      `${sha256(branch)}.json`,
    );
  }

  private async loadLegacyBranch(
    repository: RepositoryIdentity,
    branch: string,
  ): Promise<BranchReviewState | undefined> {
    if (this.legacyStorageRoot === undefined) {
      return undefined;
    }

    const legacyPath = path.join(
      this.legacyStorageRoot,
      "repositories",
      repository.key,
      "branches",
      `${sha256(branch)}.json`,
    );
    const raw = await this.readJson(legacyPath);
    if (raw === undefined) {
      return undefined;
    }

    return this.parseBranchState(raw, repository);
  }

  private parseBranchState(
    raw: unknown,
    repository: RepositoryIdentity,
  ): BranchReviewState {
    return parseBranchReviewState(raw, repository);
  }

  private async readJson(filePath: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(filePath, "utf8")) as unknown;
    } catch (error: unknown) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return undefined;
      }

      throw error;
    }
  }

  private async atomicWrite(filePath: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${String(process.pid)}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, filePath);
  }

  private async withBranchLock<T>(
    filePath: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const lockPath = `${filePath}.lock`;
    const reclaimersPath = `${lockPath}.reclaimers`;
    const owner: LockOwner = {
      token: randomUUID(),
      pid: process.pid,
      hostname: hostname(),
      createdAt: new Date().toISOString(),
    };
    const candidatePath = `${lockPath}.${owner.token}.candidate`;
    await mkdir(path.dirname(filePath), { recursive: true });
    await mkdir(candidatePath);
    await writeFile(
      path.join(candidatePath, lockOwnerFileName),
      `${JSON.stringify(owner)}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );

    let acquired = false;
    const startedAt = Date.now();
    try {
      while (!acquired) {
        if (await hasActiveReclaimers(reclaimersPath)) {
          if (Date.now() - startedAt >= this.lockTimeoutMs) {
            throw new Error(
              `Timed out waiting for the review state lock: ${lockPath}`,
            );
          }
          await delay(this.lockRetryDelayMs);
          continue;
        }

        try {
          await rename(candidatePath, lockPath);
          acquired = true;
        } catch (error: unknown) {
          if (!(await pathExists(candidatePath))) {
            throw error;
          }

          if (await this.reclaimDeadLock(lockPath, reclaimersPath)) {
            continue;
          }

          if (Date.now() - startedAt >= this.lockTimeoutMs) {
            throw new Error(
              `Timed out waiting for the review state lock: ${lockPath}`,
            );
          }

          await delay(this.lockRetryDelayMs);
        }
      }

      return await operation();
    } finally {
      if (acquired) {
        await this.removeLockIfOwned(lockPath, owner);
      } else {
        await rm(candidatePath, { recursive: true, force: true });
      }
    }
  }

  private async reclaimDeadLock(
    lockPath: string,
    reclaimersPath: string,
  ): Promise<boolean> {
    const markerPath = await createReclaimerMarker(reclaimersPath);
    try {
      const owner = await readLockOwner(lockPath);
      if (owner?.hostname !== hostname() || isProcessAlive(owner.pid)) {
        return false;
      }

      return await this.removeLockIfOwned(lockPath, owner);
    } finally {
      await rm(markerPath, { recursive: true, force: true });
    }
  }

  private async removeLockIfOwned(
    lockPath: string,
    expectedOwner: LockOwner,
  ): Promise<boolean> {
    const owner = await readLockOwner(lockPath);
    if (owner?.token !== expectedOwner.token) {
      return false;
    }

    const claimedPath = `${lockPath}.${expectedOwner.token}.${randomUUID()}.claimed`;
    try {
      await rename(lockPath, claimedPath);
    } catch (error: unknown) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return false;
      }
      throw error;
    }

    const claimedOwner = await readLockOwner(claimedPath);
    if (claimedOwner?.token !== expectedOwner.token) {
      try {
        await rename(claimedPath, lockPath);
      } catch {
        // Keep the mismatched lock intact rather than deleting another owner.
      }
      return false;
    }

    await rm(claimedPath, { recursive: true, force: true });
    return true;
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function readLockOwner(lockPath: string): Promise<LockOwner | undefined> {
  try {
    const value: unknown = JSON.parse(
      await readFile(path.join(lockPath, lockOwnerFileName), "utf8"),
    );
    return isLockOwner(value) ? value : undefined;
  } catch (error: unknown) {
    if (
      isErrnoException(error) &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return undefined;
    }
    throw error;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await readFile(path.join(filePath, lockOwnerFileName));
    return true;
  } catch (error: unknown) {
    if (
      isErrnoException(error) &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return false;
    }
    throw error;
  }
}

function isLockOwner(value: unknown): value is LockOwner {
  return (
    typeof value === "object" &&
    value !== null &&
    "token" in value &&
    typeof value.token === "string" &&
    "pid" in value &&
    typeof value.pid === "number" &&
    Number.isInteger(value.pid) &&
    "hostname" in value &&
    typeof value.hostname === "string" &&
    "createdAt" in value &&
    typeof value.createdAt === "string"
  );
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !(isErrnoException(error) && error.code === "ESRCH");
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function createReclaimerMarker(reclaimersPath: string): Promise<string> {
  await mkdir(reclaimersPath, { recursive: true });
  const markerPath = path.join(
    reclaimersPath,
    `${sha256(hostname())}.${String(process.pid)}.${randomUUID()}`,
  );
  await mkdir(markerPath);
  return markerPath;
}

async function hasActiveReclaimers(reclaimersPath: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir(reclaimersPath);
  } catch (error: unknown) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }

  const localHostHash = sha256(hostname());
  let active = false;
  for (const entry of entries) {
    const [hostHash, rawPid] = entry.split(".", 3);
    const pid = Number(rawPid);
    const markerPath = path.join(reclaimersPath, entry);
    if (
      hostHash === localHostHash &&
      Number.isInteger(pid) &&
      !isProcessAlive(pid)
    ) {
      await rm(markerPath, { recursive: true, force: true });
      continue;
    }
    active = true;
  }

  return active;
}
