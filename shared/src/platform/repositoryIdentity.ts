import path from "node:path";
import type { RepositoryIdentity } from "../domain/types.js";
import { sha256 } from "./hash.js";

export function createRepositoryIdentity(
  rootPath: string,
  commonDirectory: string,
  remoteUrl = "",
): RepositoryIdentity {
  const resolvedRootPath = path.resolve(rootPath);
  const resolvedCommonDirectory = path.resolve(commonDirectory);
  return {
    key: sha256(`${resolvedCommonDirectory}\0${remoteUrl.trim()}`),
    rootPath: resolvedRootPath,
    displayName: path.basename(resolvedRootPath),
    storageRoot: path.join(resolvedCommonDirectory, "revloop"),
  };
}
