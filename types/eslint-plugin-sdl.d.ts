declare module "@microsoft/eslint-plugin-sdl" {
  import type { ESLint, Linter } from "eslint";

  type MicrosoftSdlPlugin = Omit<ESLint.Plugin, "configs"> & {
    configs: Record<string, Linter.Config[]> & {
      common: Linter.Config[];
      node: [Linter.Config, Linter.Config];
    };
  };

  const plugin: MicrosoftSdlPlugin;
  export default plugin;
}
