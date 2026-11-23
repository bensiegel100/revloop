import * as vscode from "vscode";
import type { ReviewThread } from "@revloop/shared";
import { toVscodeRange } from "../anchors/anchorManager.js";
import { buildHistoricalDocument } from "../domain/historicalDocument.js";

const emptyDocumentScheme = "revloop-empty";
const historicalDocumentScheme = "revloop-history";
const snapshotDocumentScheme = "revloop-snapshot";

export interface HistoricalDocumentReference {
  uri: vscode.Uri;
  range: vscode.Range;
}

export class ReviewDocumentProvider
  implements vscode.TextDocumentContentProvider
{
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly historicalDocuments = new Map<string, string>();
  private readonly snapshotDocuments = new Map<string, string>();

  public readonly onDidChange = this.changeEmitter.event;

  public createEmptyUri(repositoryKey: string, filePath: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: emptyDocumentScheme,
      authority: repositoryKey,
      path: `/${filePath}`,
      query: "empty=1",
    });
  }

  public createSnapshotUri(
    repositoryKey: string,
    filePath: string,
    content: string,
  ): vscode.Uri {
    const uri = vscode.Uri.from({
      scheme: snapshotDocumentScheme,
      authority: repositoryKey,
      path: `/${filePath}`,
      query: "snapshot=1",
    });
    const key = uri.toString();
    if (this.snapshotDocuments.get(key) !== content) {
      this.snapshotDocuments.set(key, content);
      this.changeEmitter.fire(uri);
    }
    return uri;
  }

  public createHistoricalDocument(
    thread: ReviewThread,
  ): HistoricalDocumentReference {
    const historical = buildHistoricalDocument(thread);
    const uri = vscode.Uri.from({
      scheme: historicalDocumentScheme,
      authority: thread.repositoryKey,
      path: `/${thread.filePath}`,
      query: `thread=${thread.id}`,
    });
    const key = uri.toString();
    if (this.historicalDocuments.get(key) !== historical.content) {
      this.historicalDocuments.set(key, historical.content);
      this.changeEmitter.fire(uri);
    }

    return {
      uri,
      range: toVscodeRange(historical.range),
    };
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    if (uri.scheme === historicalDocumentScheme) {
      return this.historicalDocuments.get(uri.toString()) ?? "";
    }
    if (uri.scheme === snapshotDocumentScheme) {
      return this.snapshotDocuments.get(uri.toString()) ?? "";
    }
    return "";
  }

  public register(
    context: Pick<vscode.ExtensionContext, "subscriptions">,
  ): void {
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(
        emptyDocumentScheme,
        this,
      ),
      vscode.workspace.registerTextDocumentContentProvider(
        historicalDocumentScheme,
        this,
      ),
      vscode.workspace.registerTextDocumentContentProvider(
        snapshotDocumentScheme,
        this,
      ),
      this.changeEmitter,
    );
  }
}
