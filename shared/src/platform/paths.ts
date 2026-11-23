import path from "node:path";

export function normalizeRepositoryRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\/+/, "");
  const segments = normalized.split("/");

  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    segments.some((segment) => segment === ".." || segment.length === 0)
  ) {
    throw new Error(`Invalid repository-relative path: ${value}`);
  }

  return normalized;
}

export function resolveRepositoryPath(
  rootPath: string,
  relativePath: string,
): string {
  const normalized = normalizeRepositoryRelativePath(relativePath);
  const resolvedRoot = path.resolve(rootPath);
  const resolved = path.resolve(resolvedRoot, ...normalized.split("/"));
  const relative = path.relative(resolvedRoot, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes repository root: ${relativePath}`);
  }

  return resolved;
}
