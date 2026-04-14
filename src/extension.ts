import * as vscode from "vscode";
import { GitListTreeItem, GitListTreeProvider } from "./gitListTreeProvider";
import { makeEmptyDocUri, makeGitObjectUri, registerGitListDocumentProvider } from "./gitShowDocumentProvider";

/** 注册侧栏树视图、命令，并在可用时订阅内置 Git 的仓库开关事件以刷新列表。 */
export function activate(context: vscode.ExtensionContext): void {
  registerGitListDocumentProvider(context);

  const provider = new GitListTreeProvider();
  // 视图 id 须与 package.json contributes.views 中一致
  const treeView = vscode.window.createTreeView("gitListView", {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.refresh", () => provider.refresh())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.loadMoreCommits", () => provider.loadMoreCommits())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.loadMoreStashes", () => provider.loadMoreStashes())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.openPatchFileDiff", async (item?: GitListTreeItem) => {
      if (!item || item.kind !== "patchFile" || !item.repoRoot || !item.relPath) {
        return;
      }
      const repo = item.repoRoot;
      const path = item.relPath;
      let left: vscode.Uri;
      let right: vscode.Uri;
      let title: string;

      if (item.stashRef) {
        left = makeGitObjectUri(repo, `${item.stashRef}^1:${path}`);
        right = makeGitObjectUri(repo, `${item.stashRef}:${path}`);
        title = `${path} (${item.stashRef})`;
      } else if (item.hash) {
        const h = item.hash;
        if (item.changeKind === "added") {
          left = makeEmptyDocUri(repo, `empty-before-${path}`);
          right = makeGitObjectUri(repo, `${h}:${path}`);
        } else if (item.changeKind === "deleted") {
          left = makeGitObjectUri(repo, `${h}^:${path}`);
          right = makeEmptyDocUri(repo, `empty-after-${path}`);
        } else {
          left = makeGitObjectUri(repo, `${h}^:${path}`);
          right = makeGitObjectUri(repo, `${h}:${path}`);
        }
        title = `${path} (${h})`;
      } else {
        return;
      }

      await vscode.commands.executeCommand("vscode.diff", left, right, title);
    })
  );

  void subscribeBuiltInGitEvents(context, () => provider.refresh());
}

/**
 * 监听 vscode.git 打开/关闭仓库，触发刷新。
 * 未安装或激活失败时不影响扩展主体功能。
 */
async function subscribeBuiltInGitEvents(context: vscode.ExtensionContext, refresh: () => void): Promise<void> {
  try {
    const ext = vscode.extensions.getExtension("vscode.git");
    if (!ext) {
      return;
    }
    await ext.activate();
    const api = ext.exports?.getAPI?.(1);
    if (!api) {
      return;
    }
    context.subscriptions.push(api.onDidOpenRepository(refresh));
    context.subscriptions.push(api.onDidCloseRepository(refresh));
  } catch {
    // Built-in Git unavailable; extension still works without auto-refresh hooks.
  }
}

export function deactivate(): void {}
