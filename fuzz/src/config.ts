export interface FuzzParameters {
  readonly numRuns?: number;
  readonly seed?: number;
  readonly path?: string;
}

export function fuzzParameters(): FuzzParameters {
  const numRuns = readPositiveInteger("REVLOOP_FUZZ_RUNS");
  const seed = readInteger("REVLOOP_FUZZ_SEED");
  const replayPath = process.env.REVLOOP_FUZZ_PATH?.trim();

  return {
    ...(numRuns === undefined ? {} : { numRuns }),
    ...(seed === undefined ? {} : { seed }),
    ...(replayPath === undefined || replayPath.length === 0
      ? {}
      : { path: replayPath }),
  };
}

function readPositiveInteger(name: string): number | undefined {
  const value = readInteger(name);
  if (value !== undefined && value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function readInteger(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer.`);
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a safe integer.`);
  }
  return value;
}
