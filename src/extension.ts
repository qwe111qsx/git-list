import * as vscode from "vscode";
import { execFile } from "child_process";
import { promisify } from "util";
import { clearAuthorStylesStore } from "./authorStyles";
import { GitListTreeItem, GitListTreeProvider, resolveWorkspaceGitRoot } from "./gitListTreeProvider";
import { makeEmptyDocUri, makeGitObjectUri, registerGitListDocumentProvider } from "./gitShowDocumentProvider";

const execFileAsync = promisify(execFile);

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
    treeView.onDidExpandElement((e) => provider.onViewTreeElementExpanded(e.element))
  );
  context.subscriptions.push(
    treeView.onDidCollapseElement((e) => provider.onViewTreeElementCollapsed(e.element))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.refresh", () => provider.refresh())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.refreshCommits", () => provider.refreshCommitsList())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.refreshStash", () => provider.refreshStashList())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.refreshBranches", () => provider.refreshBranchesList())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.clearAuthorColors", async () => {
      await clearAuthorStylesStore(context);
      provider.refresh();
      void vscode.window.showInformationMessage(vscode.l10n.t("gitList.authorColorsCleared"));
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.loadMoreCommits", () => provider.loadMoreCommits())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.loadMoreStashes", () => provider.loadMoreStashes())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.loadMoreBranchCommits", (item?: GitListTreeItem) => {
      const target = item ?? treeView.selection[0];
      if (target) {
        provider.loadMoreBranchCommits(target);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.loadMoreBranches", () => provider.loadMoreBranches())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.applyStash", async (item?: GitListTreeItem) => {
      const target = item ?? treeView.selection[0];
      if (!target || target.kind !== "stash" || !target.stashRef) {
        void vscode.window.showWarningMessage(vscode.l10n.t("gitList.stashActionPick"));
        return;
      }
      const repo = await resolveWorkspaceGitRoot();
      if (!repo) {
        void vscode.window.showWarningMessage(vscode.l10n.t("gitList.noGitRepo"));
        return;
      }
      try {
        await execFileAsync("git", ["stash", "apply", target.stashRef], {
          cwd: repo,
          maxBuffer: 10 * 1024 * 1024,
        });
        void vscode.window.showInformationMessage(
          `${vscode.l10n.t("gitList.applyStashDoneIntro")}\n${target.stashRef}`
        );
        provider.refresh();
      } catch (err) {
        const stderr =
          err && typeof err === "object" && "stderr" in err
            ? String((err as { stderr?: Buffer }).stderr ?? "")
            : "";
        const hint = stderr.trim() || (err instanceof Error ? err.message : String(err));
        void vscode.window.showErrorMessage(vscode.l10n.t("gitList.applyStashFailed", hint));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.dropStash", async (item?: GitListTreeItem) => {
      const target = item ?? treeView.selection[0];
      if (!target || target.kind !== "stash" || !target.stashRef) {
        void vscode.window.showWarningMessage(vscode.l10n.t("gitList.stashActionPick"));
        return;
      }
      const stashTitle =
        typeof target.label === "string"
          ? target.label
          : (target.label?.label ?? target.stashRef);
      const confirm = vscode.l10n.t("gitList.dropStashConfirmButton");
      const picked = await vscode.window.showWarningMessage(
        `${vscode.l10n.t("gitList.dropStashConfirmIntro")}\n\n${stashTitle}`,
        { modal: true },
        confirm
      );
      if (picked !== confirm) {
        return;
      }
      const repo = await resolveWorkspaceGitRoot();
      if (!repo) {
        void vscode.window.showWarningMessage(vscode.l10n.t("gitList.noGitRepo"));
        return;
      }
      try {
        await execFileAsync("git", ["stash", "drop", target.stashRef], {
          cwd: repo,
          maxBuffer: 1024 * 1024,
        });
        void vscode.window.showInformationMessage(
          `${vscode.l10n.t("gitList.dropStashDoneIntro")}\n${stashTitle}`
        );
        provider.notifyStashDropped(target.stashRef, target.hash);
      } catch (err) {
        const stderr =
          err && typeof err === "object" && "stderr" in err
            ? String((err as { stderr?: Buffer }).stderr ?? "")
            : "";
        const hint = stderr.trim() || (err instanceof Error ? err.message : String(err));
        void vscode.window.showErrorMessage(vscode.l10n.t("gitList.dropStashFailed", hint));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.deleteBranch", async (item?: GitListTreeItem) => {
      const target = item ?? treeView.selection[0];
      if (!target || target.kind !== "branch" || !target.branchName) {
        void vscode.window.showWarningMessage(vscode.l10n.t("gitList.deleteBranchPick"));
        return;
      }
      const branchName = target.branchName;
      const repo = await resolveWorkspaceGitRoot();
      if (!repo) {
        void vscode.window.showWarningMessage(vscode.l10n.t("gitList.noGitRepo"));
        return;
      }
      let currentHead: string;
      try {
        const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: repo,
          maxBuffer: 64 * 1024,
        });
        currentHead = stdout.trim();
      } catch {
        void vscode.window.showErrorMessage(vscode.l10n.t("gitList.deleteBranchReadHeadFailed"));
        return;
      }
      if (currentHead === branchName) {
        void vscode.window.showWarningMessage(
          vscode.l10n.t("gitList.deleteBranchCurrent", branchName)
        );
        return;
      }
      const confirm = vscode.l10n.t("gitList.deleteBranchConfirmButton");
      const picked = await vscode.window.showWarningMessage(
        vscode.l10n.t("gitList.deleteBranchConfirmIntro", branchName),
        { modal: true },
        confirm
      );
      if (picked !== confirm) {
        return;
      }
      try {
        await execFileAsync("git", ["branch", "-d", branchName], {
          cwd: repo,
          maxBuffer: 1024 * 1024,
        });
        void vscode.window.showInformationMessage(
          vscode.l10n.t("gitList.deleteBranchDone", branchName)
        );
        provider.notifyBranchDeleted(branchName);
      } catch (err) {
        const stderr =
          err && typeof err === "object" && "stderr" in err
            ? String((err as { stderr?: Buffer }).stderr ?? "")
            : "";
        const hint = stderr.trim() || (err instanceof Error ? err.message : String(err));
        void vscode.window.showErrorMessage(vscode.l10n.t("gitList.deleteBranchFailed", hint));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.createBranchFromCommit", async (item?: GitListTreeItem) => {
      const target = item ?? treeView.selection[0];
      if (!target || target.kind !== "commit" || !target.commitMeta?.fullHash) {
        void vscode.window.showWarningMessage(vscode.l10n.t("gitList.createBranchPickCommit"));
        return;
      }
      const repo = await resolveWorkspaceGitRoot();
      if (!repo) {
        void vscode.window.showWarningMessage(vscode.l10n.t("gitList.noGitRepo"));
        return;
      }
      const full = target.commitMeta.fullHash.trim();
      const defaultName = full.length > 7 ? full.slice(0, 7) : full;
      const branchName = await vscode.window.showInputBox({
        title: vscode.l10n.t("gitList.createBranchInputTitle"),
        prompt: vscode.l10n.t("gitList.createBranchInputPrompt"),
        value: defaultName,
        valueSelection: [0, defaultName.length],
        validateInput: (v) => {
          const t = v.trim();
          if (!t) {
            return vscode.l10n.t("gitList.createBranchInputEmpty");
          }
          return undefined;
        },
      });
      if (branchName === undefined) {
        return;
      }
      const name = branchName.trim();
      try {
        await execFileAsync("git", ["checkout", "-b", name, full], {
          cwd: repo,
          maxBuffer: 1024 * 1024,
        });
        void vscode.window.showInformationMessage(
          vscode.l10n.t("gitList.createBranchDone", name)
        );
        provider.refresh();
      } catch (err) {
        const stderr =
          err && typeof err === "object" && "stderr" in err
            ? String((err as { stderr?: Buffer }).stderr ?? "")
            : "";
        const hint = stderr.trim() || (err instanceof Error ? err.message : String(err));
        void vscode.window.showErrorMessage(vscode.l10n.t("gitList.createBranchFailed", hint));
      }
    })
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

/** 内置 Git 扩展返回的 Repository 形态（仅用到本扩展需要的字段）。 */
interface BuiltInGitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly onDidChange: vscode.Event<void>;
  };
  readonly onDidCheckout: vscode.Event<void>;
  readonly onDidCommit: vscode.Event<void>;
}

type BuiltInGitApiState = "uninitialized" | "initialized";

interface BuiltInGitApi {
  readonly state: BuiltInGitApiState;
  readonly onDidChangeState: vscode.Event<BuiltInGitApiState>;
  readonly repositories: BuiltInGitRepository[];
  readonly onDidOpenRepository: vscode.Event<BuiltInGitRepository>;
  readonly onDidCloseRepository: vscode.Event<BuiltInGitRepository>;
  getRepository(uri: vscode.Uri): BuiltInGitRepository | null;
}

function normalizeRepoRoot(fsPath: string): string {
  const n = fsPath.replace(/\\/g, "/");
  return process.platform === "win32" ? n.toLowerCase() : n;
}

function repoMatchesAnyWorkspaceFolder(api: BuiltInGitApi, repo: BuiltInGitRepository): boolean {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    return false;
  }
  const target = normalizeRepoRoot(repo.rootUri.fsPath);
  for (const wf of folders) {
    const gr = api.getRepository(wf.uri);
    if (!gr) {
      continue;
    }
    if (normalizeRepoRoot(gr.rootUri.fsPath) === target) {
      return true;
    }
  }
  return false;
}

/**
 * 监听 vscode.git：仓库开闭、以及仓库状态变化（切换分支、pull、commit、索引变更等），防抖后刷新侧栏。
 * 仅当变化来自「当前工作区文件夹所对应的仓库」时才刷新，避免多根工作区下无关仓库拖慢界面。
 * 未安装或激活失败时不影响扩展主体功能。
 */
async function subscribeBuiltInGitEvents(context: vscode.ExtensionContext, refresh: () => void): Promise<void> {
  try {
    const ext = vscode.extensions.getExtension("vscode.git");
    if (!ext) {
      return;
    }
    await ext.activate();
    const api = ext.exports?.getAPI?.(1) as BuiltInGitApi | undefined;
    if (!api) {
      return;
    }

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefresh = (): void => {
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        refresh();
      }, 400);
    };

    const workspaceRepoChanged = (repo: BuiltInGitRepository): void => {
      if (!repoMatchesAnyWorkspaceFolder(api, repo)) {
        return;
      }
      scheduleRefresh();
    };

    const repoStateDisposables = new Map<string, vscode.Disposable>();

    const attachRepoStateListener = (repo: BuiltInGitRepository): void => {
      const key = repo.rootUri.fsPath;
      if (repoStateDisposables.has(key)) {
        return;
      }
      const d = vscode.Disposable.from(
        repo.state.onDidChange(() => workspaceRepoChanged(repo)),
        repo.onDidCheckout(() => workspaceRepoChanged(repo)),
        repo.onDidCommit(() => workspaceRepoChanged(repo))
      );
      repoStateDisposables.set(key, d);
    };

    const detachRepoStateListener = (repo: BuiltInGitRepository): void => {
      const key = repo.rootUri.fsPath;
      const d = repoStateDisposables.get(key);
      d?.dispose();
      repoStateDisposables.delete(key);
    };

    const wireExistingRepositories = (): void => {
      for (const repo of api.repositories) {
        attachRepoStateListener(repo);
      }
    };

    if (api.state === "initialized") {
      wireExistingRepositories();
    } else {
      context.subscriptions.push(
        api.onDidChangeState((st) => {
          if (st === "initialized") {
            wireExistingRepositories();
          }
        })
      );
    }

    context.subscriptions.push(
      api.onDidOpenRepository((repo) => {
        refresh();
        attachRepoStateListener(repo);
      })
    );
    context.subscriptions.push(
      api.onDidCloseRepository((repo) => {
        detachRepoStateListener(repo);
        refresh();
      })
    );

    context.subscriptions.push(
      new vscode.Disposable(() => {
        if (debounceTimer !== undefined) {
          clearTimeout(debounceTimer);
        }
        for (const d of repoStateDisposables.values()) {
          d.dispose();
        }
        repoStateDisposables.clear();
      })
    );
  } catch {
    // Built-in Git unavailable; extension still works without auto-refresh hooks.
  }
}

export function deactivate(): void {}
