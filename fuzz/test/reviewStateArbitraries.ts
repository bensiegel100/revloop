import {
  branchRefArbitrary,
  repositoryTemplateArbitrary,
  reviewThreadsArbitrary,
  timestampArbitrary,
} from "../src/index.js";
import type { RepositoryTemplate } from "../src/index.js";
import type { ReviewThread } from "@revloop/shared";
import * as fc from "fast-check";

export interface PersistenceScenario {
  readonly repository: RepositoryTemplate;
  readonly branch: string;
  readonly snapshots: readonly (readonly ReviewThread[])[];
  readonly legacyState: {
    readonly revision: number;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
}

export interface BranchIsolationScenario {
  readonly repository: RepositoryTemplate;
  readonly branches: readonly {
    readonly branch: string;
    readonly threads: readonly ReviewThread[];
  }[];
}

const stateTimestampsArbitrary = fc
  .tuple(timestampArbitrary, timestampArbitrary)
  .map(([first, second]) =>
    first.localeCompare(second) <= 0
      ? { createdAt: first, updatedAt: second }
      : { createdAt: second, updatedAt: first },
  );

export const persistenceScenarioArbitrary: fc.Arbitrary<PersistenceScenario> =
  createPersistenceScenarioArbitrary(1, 4);

export const concurrentPersistenceScenarioArbitrary: fc.Arbitrary<PersistenceScenario> =
  createPersistenceScenarioArbitrary(2, 5);

export const branchIsolationScenarioArbitrary: fc.Arbitrary<BranchIsolationScenario> =
  repositoryTemplateArbitrary.chain((repository) =>
    fc
      .uniqueArray(
        branchRefArbitrary.chain((branch) =>
          reviewThreadsArbitrary(repository.key, branch).map((threads) => ({
            branch,
            threads,
          })),
        ),
        {
          minLength: 2,
          maxLength: 6,
          selector: (branchState) => branchState.branch,
        },
      )
      .map((branches) => ({
        repository,
        branches,
      })),
  );

function createPersistenceScenarioArbitrary(
  minSnapshots: number,
  maxSnapshots: number,
): fc.Arbitrary<PersistenceScenario> {
  return repositoryTemplateArbitrary.chain((repository) =>
    branchRefArbitrary.chain((branch) =>
      fc
        .record({
          snapshots: fc.array(reviewThreadsArbitrary(repository.key, branch), {
            minLength: minSnapshots,
            maxLength: maxSnapshots,
          }),
          legacyState: fc.record({
            revision: fc.nat({ max: 10_000 }),
            timestamps: stateTimestampsArbitrary,
          }),
        })
        .map(({ snapshots, legacyState }) => ({
          repository,
          branch,
          snapshots,
          legacyState: {
            revision: legacyState.revision,
            ...legacyState.timestamps,
          },
        })),
    ),
  );
}
