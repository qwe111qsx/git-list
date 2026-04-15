import * as vscode from "vscode";
import { clearAuthorStylesStore } from "./authorStyles";
import { GitListTreeItem, GitListTreeProvider } from "./gitListTreeProvider";
import { makeEmptyDocUri, makeGitObjectUri, registerGitListDocumentProvider } from "./gitShowDocumentProvider";

function diffPathBasename(path: string): string {
  const n = path.replace(/\\/g, "/");
  const i = n.lastIndexOf("/");
  return i >= 0 ? n.slice(i + 1) : n;
}

function shortHashForTitle(hash: string): string {
  const h = hash.trim();
  return h.length > 7 ? h.slice(0, 7) : h;
}

function stashRefShortForTitle(stashRef: string): string {
  const m = stashRef.match(/^stash@\{(\d+)\}$/);
  return m ? `#${m[1]}` : stashRef;
}

/** 注册侧栏树视图、命令，并在可用时订阅内置 Git 的仓库开关事件以刷新列表。 */
export function activate(context: vscode.ExtensionContext): void {
  registerGitListDocumentProvider(context);

  const provider = new GitListTreeProvider(context);
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
    vscode.commands.registerCommand("gitList.clearAuthorColors", async () => {
      await clearAuthorStylesStore(context);
      provider.refresh();
      void vscode.window.showInformationMessage(vscode.l10n.t("gitList.authorColorsCleared"));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.openSupportPage", async () => {
      const uri = vscode.Uri.joinPath(context.extensionUri, "docs", "support.html");
      await vscode.env.openExternal(uri);
    })
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
        title = `${diffPathBasename(path)} (${stashRefShortForTitle(item.stashRef)})`;
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
        title = `${diffPathBasename(path)} (${shortHashForTitle(h)})`;
      } else {
        return;
      }

      await vscode.commands.executeCommand("vscode.diff", left, right, title);
    })
  );

  void subscribeBuiltInGitEvents(context, () => provider.refresh());

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("git-list")) {
        provider.onGitListConfigurationChanged();
      }
    })
  );
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
