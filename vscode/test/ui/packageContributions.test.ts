import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

interface MenuContribution {
  command: string;
  when?: string;
  group?: string;
}

interface CommandContribution {
  command: string;
  enablement?: string;
}

interface ExtensionManifest {
  contributes: {
    commands?: CommandContribution[];
    keybindings?: {
      command: string;
    }[];
    menus?: Record<string, MenuContribution[]>;
    configurationDefaults?: Record<string, unknown>;
  };
}

let manifest: ExtensionManifest;

beforeAll(async () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const value: unknown = JSON.parse(
    await readFile(path.resolve(directory, "../../package.json"), "utf8"),
  );
  if (!isExtensionManifest(value)) {
    throw new Error("Invalid extension manifest fixture.");
  }
  manifest = value;
});

describe("comment UI contributions", () => {
  it("does not override native comment-editor keybindings", () => {
    expect(
      manifest.contributes.keybindings?.some(
        (candidate) => candidate.command === "editor.action.submitComment",
      ),
    ).not.toBe(true);
  });

  it("does not override collapse confirmation for other providers", () => {
    expect(
      manifest.contributes.configurationDefaults?.[
        "comments.thread.confirmOnCollapse"
      ],
    ).toBeUndefined();
  });

  it("offers resolve actions inline without dead sidebar thread items", () => {
    const inline = manifest.contributes.menus?.["comments/commentThread/title"];
    const sidebar = manifest.contributes.menus?.["view/item/context"];

    expect(
      inline?.some(
        (item) =>
          item.command === "revloop.resolveThread" &&
          item.when?.includes("commentThread == revloop.outdated") === true,
      ),
    ).toBe(true);
    expect(
      sidebar?.some(
        (item) => item.when?.includes("viewItem == revloop.thread.") === true,
      ),
    ).not.toBe(true);
  });

  it("offers edit controls only for user-authored comments", () => {
    const title = manifest.contributes.menus?.["comments/comment/title"];
    const context = manifest.contributes.menus?.["comments/comment/context"];
    const save = manifest.contributes.commands?.find(
      (command) => command.command === "revloop.saveComment",
    );
    const saveAction = context?.find(
      (item) => item.command === "revloop.saveComment",
    );
    const cancelAction = context?.find(
      (item) => item.command === "revloop.cancelCommentEdit",
    );

    expect(
      title?.some(
        (item) =>
          item.command === "revloop.editComment" &&
          item.when?.includes("comment == revloop.user") === true,
      ),
    ).toBe(true);
    expect(
      context?.some(
        (item) =>
          item.command === "revloop.cancelCommentEdit" &&
          item.when?.includes("comment == revloop.user") === true,
      ),
    ).toBe(true);
    expect(
      context?.some(
        (item) =>
          item.command === "revloop.saveComment" &&
          item.when?.includes("comment == revloop.user") === true,
      ),
    ).toBe(true);
    expect(save?.enablement).toBe("!commentIsEmpty");
    expect(saveAction?.group).toBe("inline@1");
    expect(cancelAction?.group).toBe("inline@2");
  });
});

function isExtensionManifest(value: unknown): value is ExtensionManifest {
  return (
    typeof value === "object" &&
    value !== null &&
    "contributes" in value &&
    typeof value.contributes === "object" &&
    value.contributes !== null
  );
}
