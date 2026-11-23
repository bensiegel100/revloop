export interface NamedRef {
  readonly name?: string;
}

export function collectBaseBranchCandidates(
  currentBranch: string,
  ...refGroups: readonly (readonly NamedRef[])[]
): string[] {
  const candidates = refGroups
    .flat()
    .map((ref) => ref.name?.trim())
    .filter((name): name is string => name !== undefined && name.length > 0)
    .filter((name) => name !== currentBranch && !name.endsWith("/HEAD"));

  return [...new Set(candidates)].sort((left, right) =>
    left.localeCompare(right),
  );
}
