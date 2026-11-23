export class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export class Range {
  constructor(startOrLine, startCharacterOrEnd, endLine, endCharacter) {
    if (typeof startOrLine === "number") {
      this.start = { line: startOrLine, character: startCharacterOrEnd };
      this.end = { line: endLine, character: endCharacter };
    } else {
      this.start = startOrLine;
      this.end = startCharacterOrEnd;
    }
  }

  get isEmpty() {
    return (
      this.start.line === this.end.line &&
      this.start.character === this.end.character
    );
  }
}

export class Selection extends Range {}

export class Uri {
  constructor(scheme, fsPath, value) {
    this.scheme = scheme;
    this.fsPath = fsPath;
    this.path = fsPath;
    this.value = value ?? `${scheme}:${fsPath}`;
  }

  static file(filePath) {
    return new Uri("file", filePath);
  }

  static from(parts) {
    return new Uri(parts.scheme, parts.path ?? "", JSON.stringify(parts));
  }

  toString() {
    return this.value;
  }
}

export class MarkdownString {
  constructor(value = "") {
    this.value = value;
  }

  appendMarkdown(value) {
    this.value += value;
  }

  appendText(value) {
    this.value += value;
  }
}

export class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => {
      this.listeners.add(listener);
      return {
        dispose: () => {
          this.listeners.delete(listener);
        },
      };
    };
  }

  fire(value) {
    for (const listener of this.listeners) {
      listener(value);
    }
  }

  dispose() {
    this.listeners.clear();
  }
}

export class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}

export class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

export const CommentMode = { Editing: 0, Preview: 1 };
export const CommentThreadState = { Unresolved: 0, Resolved: 1 };
export const CommentThreadCollapsibleState = {
  Collapsed: 0,
  Expanded: 1,
};
export const TreeItemCollapsibleState = {
  None: 0,
  Collapsed: 1,
  Expanded: 2,
};
export const TextEditorRevealType = { InCenter: 0 };
export const ExtensionKind = { UI: 1, Workspace: 2 };

export const mockState = {
  commentControllers: [],
  commentThreads: [],
  executedCommands: [],
  registeredCommands: new Map(),
  treeViews: [],
};

export const comments = {
  createCommentController() {
    const controller = {
      commentingRangeProvider: undefined,
      options: undefined,
      createCommentThread(uri, range, threadComments) {
        const thread = {
          uri,
          range,
          comments: threadComments,
          dispose() {},
        };
        mockState.commentThreads.push(thread);
        return thread;
      },
      dispose() {},
    };
    mockState.commentControllers.push(controller);
    return controller;
  },
};

export const commands = {
  async executeCommand(command, ...arguments_) {
    mockState.executedCommands.push({ command, arguments: arguments_ });
    const handler = mockState.registeredCommands.get(command);
    return handler?.(...arguments_);
  },
  registerCommand(command, handler) {
    mockState.registeredCommands.set(command, handler);
    return {
      dispose() {
        mockState.registeredCommands.delete(command);
      },
    };
  },
  getCommands() {
    return Promise.resolve([...mockState.registeredCommands.keys()]);
  },
};

export const extensions = {
  getExtension() {
    return undefined;
  },
};

export const window = {
  activeTextEditor: undefined,
  createTreeView(id, options) {
    const treeView = {
      id,
      options,
      description: "",
      dispose() {},
    };
    mockState.treeViews.push(treeView);
    return treeView;
  },
  showErrorMessage() {
    return Promise.resolve(undefined);
  },
  showInputBox() {
    return Promise.resolve(undefined);
  },
  showQuickPick(items) {
    return Promise.resolve(items[0]);
  },
  showTextDocument() {
    return Promise.resolve(undefined);
  },
  showWarningMessage() {
    return Promise.resolve(undefined);
  },
};

export const workspace = {
  workspaceFolders: undefined,
  getConfiguration() {
    return {
      get(_key, defaultValue) {
        return defaultValue;
      },
    };
  },
  onDidChangeTextDocument() {
    return { dispose() {} };
  },
  openTextDocument() {
    return Promise.reject(new Error("No text document fixture was provided."));
  },
  registerTextDocumentContentProvider() {
    return { dispose() {} };
  },
};

export function resetVscodeMock() {
  mockState.commentControllers.length = 0;
  mockState.commentThreads.length = 0;
  mockState.executedCommands.length = 0;
  mockState.registeredCommands.clear();
  mockState.treeViews.length = 0;
  window.activeTextEditor = undefined;
  workspace.workspaceFolders = undefined;
}
