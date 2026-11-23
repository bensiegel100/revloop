import { execFileSync } from "node:child_process";

const npmCli = process.env.npm_execpath;
if (npmCli === undefined || npmCli.length === 0) {
  throw new Error("npm_execpath is required to run pre-commit checks.");
}

for (const script of ["check-types", "test:coverage"]) {
  execFileSync(process.execPath, [npmCli, "run", script], {
    stdio: "inherit",
  });
}
