import eslint from "@eslint/js";
import microsoftSdl from "@microsoft/eslint-plugin-sdl";
import vitest from "@vitest/eslint-plugin";
import { flatConfigs as importXConfigs } from "eslint-plugin-import-x";
import nodePlugin from "eslint-plugin-n";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

const codeFiles = [
  "eslint.config.mjs",
  "scripts/**/*.{js,mjs,cjs}",
  "types/**/*.ts",
  "{shared,vscode,mcp}/**/*.{ts,js,mjs,cjs}",
];
const typeScriptFiles = ["types/**/*.ts", "{shared,vscode,mcp}/**/*.ts"];
const typeCheckedFiles = [
  ...typeScriptFiles,
  "eslint.config.mjs",
  "scripts/**/*.mjs",
  "{shared,vscode,mcp}/esbuild.mjs",
];
const vitestFiles = ["{shared,vscode,mcp}/test/**/*.test.ts"];
const node20RuntimeFiles = ["shared/src/**/*.ts", "mcp/src/**/*.ts"];
const node22RuntimeFiles = ["vscode/src/**/*.ts"];
const nodeModuleFiles = [
  "eslint.config.mjs",
  "scripts/**/*.{js,mjs}",
  "{shared,vscode,mcp}/esbuild.mjs",
  "mcp/test/**/*.mjs",
  "vscode/test/extension/**/*.mjs",
];
const nodeScriptFiles = ["vscode/test/extension/**/*.cjs"];

export default defineConfig(
  {
    ignores: ["**/dist/**", "node_modules", "plugin/server/**"],
  },
  eslint.configs.recommended,
  ...withFiles(tseslint.configs.strictTypeChecked, typeCheckedFiles),
  ...withFiles(tseslint.configs.stylisticTypeChecked, typeCheckedFiles),
  {
    files: typeCheckedFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/no-confusing-void-expression": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          checksConditionals: true,
          checksSpreads: true,
          checksVoidReturn: true,
        },
      ],
      "@typescript-eslint/no-unsafe-type-assertion": "error",
      "@typescript-eslint/prefer-readonly": "error",
      "@typescript-eslint/strict-boolean-expressions": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  withFile(importXConfigs.recommended, codeFiles),
  withFile(importXConfigs.typescript, typeScriptFiles),
  {
    files: codeFiles,
    rules: {
      curly: ["error", "all"],
      eqeqeq: [
        "error",
        "always",
        {
          null: "ignore",
        },
      ],
      "import-x/consistent-type-specifier-style": ["error", "prefer-top-level"],
      "import-x/first": "error",
      "import-x/newline-after-import": "error",
      "import-x/no-cycle": "error",
      "import-x/no-duplicates": "error",
      "import-x/no-named-as-default": "error",
      "import-x/no-named-as-default-member": "error",
      "import-x/no-self-import": "error",
      "import-x/no-unresolved": [
        "error",
        {
          commonjs: true,
          ignore: ["^vscode$"],
        },
      ],
      "import-x/no-useless-path-segments": "error",
      "object-shorthand": "error",
      "prefer-object-spread": "error",
      radix: "error",
    },
  },
  ...withFiles(microsoftSdl.configs.common, codeFiles),
  withFile(microsoftSdl.configs.node[1], codeFiles),
  nodeRuntimeConfig(node20RuntimeFiles, ">=20.0.0"),
  nodeRuntimeConfig(node22RuntimeFiles, ">=22.0.0"),
  nodeConfig(nodePlugin.configs["flat/recommended-module"], nodeModuleFiles),
  nodeConfig(nodePlugin.configs["flat/recommended-script"], nodeScriptFiles),
  {
    ...vitest.configs.recommended,
    files: vitestFiles,
    rules: {
      ...vitest.configs.recommended.rules,
      "vitest/no-disabled-tests": "error",
    },
  },
);

/**
 * @param {readonly import("eslint").Linter.Config[]} configs
 * @param {string[]} files
 * @returns {import("eslint").Linter.Config[]}
 */
function withFiles(configs, files) {
  return configs.map((config) => withFile(config, files));
}

/**
 * @param {import("eslint").Linter.Config} config
 * @param {string[]} files
 * @returns {import("eslint").Linter.Config}
 */
function withFile(config, files) {
  return {
    ...config,
    files,
  };
}

/**
 * @param {string[]} files
 * @param {string} version
 * @returns {import("eslint").Linter.Config}
 */
function nodeRuntimeConfig(files, version) {
  return {
    files,
    languageOptions: {
      globals: globals.node,
    },
    plugins: {
      n: nodePlugin,
    },
    settings: {
      node: {
        version,
      },
    },
    rules: {
      "n/no-deprecated-api": "error",
      "n/no-unsupported-features/es-builtins": "error",
      "n/no-unsupported-features/es-syntax": [
        "error",
        {
          ignores: ["modules"],
        },
      ],
      "n/no-unsupported-features/node-builtins": "error",
    },
  };
}

/**
 * @param {import("eslint").Linter.Config} config
 * @param {string[]} files
 * @returns {import("eslint").Linter.Config}
 */
function nodeConfig(config, files) {
  return {
    ...config,
    files,
    settings: {
      node: {
        version: "22.22.1",
      },
    },
    rules: {
      ...config.rules,
      "n/no-extraneous-import": "off",
      "n/no-extraneous-require": "off",
      "n/no-missing-import": "off",
      "n/no-missing-require": "off",
      "n/no-unpublished-import": "off",
      "n/no-unpublished-require": "off",
    },
  };
}
