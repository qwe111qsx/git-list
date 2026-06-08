import * as vscode from "vscode";
import { execFile } from "child_process";
import { promisify } from "util";
import { clearAuthorStylesStore } from "./authorStyles";
import { registerCursorLineGitHint } from "./cursorLineGitHint";
import { GitListTreeItem, GitListTreeProvider, invalidateWorkspaceGitRootCache, resolveWorkspaceGitRoot, syncWorkspaceGitRepoContext } from "./gitListTreeProvider";
import {
  makeEmptyDocUri,
  makeGitObjectUri,
  parseGitListRevUri,
  registerGitListDocumentProvider,
  workingTreeFileUri,
} from "./gitShowDocumentProvider";
import { openCommitFileDiff } from "./openCommitFileDiff";

const execFileAsync = promisify(execFile);

const GIT_ERROR_DETAIL_MAX = 12000;

let gitListOutput: vscode.OutputChannel | undefined;

function bufferOrStringToText(v: Buffer | string | undefined | null): string {
  if (v === undefined || v === null) {
    return "";
  }
  return typeof v === "string" ? v : v.toString("utf8");
}

/**
 * 汇总 git 在 stderr / stdout 中的输出（合并冲突、未合并文件等常在 stdout），
 * 避免只显示 Node 的 “Command failed: …”。
 */
function formatGitExecError(err: unknown): string {
  const e = err as { stderr?: Buffer | string; stdout?: Buffer | string };
  const stderr = bufferOrStringToText(e.stderr).trim();
  const stdout = bufferOrStringToText(e.stdout).trim();
  const parts: string[] = [];
  if (stderr) {
    parts.push(stderr);
  }
  if (stdout && !stderr.includes(stdout)) {
    parts.push(stdout);
  }
  let text = parts.join("\n\n").trim();
  if (!text) {
    text = (err instanceof Error ? err.message : String(err)).trim();
  }
  text = text.replace(/\r\n/g, "\n");
  if (text.length > GIT_ERROR_DETAIL_MAX) {
    text = `${text.slice(0, GIT_ERROR_DETAIL_MAX)}\n…`;
  }
  return text || "Unknown error";
}

function showGitErrorMessage(summaryL10nKey: string, err: unknown): void {
  const detail = formatGitExecError(err);
  const summary = vscode.l10n.t(summaryL10nKey);
  const stamp = new Date().toISOString();
  gitListOutput?.appendLine(`\n━━ ${stamp} ${summary} ━━\n${detail}\n`);
  const openLog = vscode.l10n.t("gitList.openOutputLog");
  const full = `${summary}\n\n${detail}`;
  const toast =
    full.length > 3200 ? `${summary}\n\n${detail.slice(0, 2800)}\n…` : full;
  void vscode.window.showErrorMessage(toast, openLog).then((picked) => {
    if (picked === openLog) {
      gitListOutput?.show(true);
    }
  });
}

/** 批量清理：分支 tip 的 committer 日期早于此则视为「早于半年」。 */
const DELETE_BRANCHES_OLDER_THAN_MONTHS = 6;

function cutoffDateMonthsAgo(months: number): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d;
}

async function listLocalBranchTipDates(repo: string): Promise<{ name: string; tipDate: Date }[]> {
  const formats = [
    "%(refname:short)\t%(committerdate:iso-strict)",
    "%(refname:short)\t%(committerdate:iso8601)",
  ];
  let stdout = "";
  for (const fmt of formats) {
    try {
      const { stdout: out } = await execFileAsync(
        "git",
        ["for-each-ref", "refs/heads", `--format=${fmt}`],
        { cwd: repo, maxBuffer: 1024 * 1024 }
      );
      stdout = out;
      break;
    } catch {
      /* try next format */
    }
  }
  if (!stdout.trim()) {
    return [];
  }
  const out: { name: string; tipDate: Date }[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const tab = line.indexOf("\t");
    if (tab < 0) {
      continue;
    }
    const name = line.slice(0, tab).trim();
    const dateStr = line.slice(tab + 1).trim();
    const tipDate = new Date(dateStr);
    if (name && !Number.isNaN(tipDate.getTime())) {
      out.push({ name, tipDate });
    }
  }
  return out;
}

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

async function readCurrentBranchName(repo: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["branch", "--show-current"], {
      cwd: repo,
      maxBuffer: 4096,
    });
    const name = stdout.trim();
    if (name) {
      return name;
    }
    const { stdout: abbrOut } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repo,
      maxBuffer: 4096,
    });
    const abbr = abbrOut.trim();
    if (abbr && abbr !== "HEAD") {
      return abbr;
    }
    return vscode.l10n.t("gitList.headDetachedBranchLabel");
  } catch {
    return undefined;
  }
}

async function readCurrentBranchHeadRef(repo: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repo,
      maxBuffer: 4096,
    });
    const head = stdout.trim();
    return head || undefined;
  } catch {
    return undefined;
  }
}

async function isCommitAncestorOfHead(repo: string, commit: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], {
      cwd: repo,
      maxBuffer: 4096,
    });
    return true;
  } catch {
    return false;
  }
}

/** 注册侧栏树视图、命令，并在可用时订阅内置 Git 的仓库开关事件以刷新列表。 */
export function activate(context: vscode.ExtensionContext): void {
  void vscode.commands.executeCommand("setContext", "gitList.hasWorkspaceGitRepo", false);

  registerGitListDocumentProvider(context);
  registerCursorLineGitHint(context);

  gitListOutput = vscode.window.createOutputChannel("Git List");
  context.subscriptions.push(gitListOutput);

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
    vscode.commands.registerCommand("gitList.refresh", () => {
      invalidateWorkspaceGitRootCache();
      provider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.initRepository", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        void vscode.window.showWarningMessage(vscode.l10n.t("gitList.openFolderHint"));
        return;
      }
      const existing = await resolveWorkspaceGitRoot();
      if (existing) {
        await syncWorkspaceGitRepoContext();
        provider.refresh();
        return;
      }
      const cwd = folder.uri.fsPath;
      try {
        await initWorkspaceGitRepository(folder.uri);
        invalidateWorkspaceGitRootCache();
        void vscode.window.showInformationMessage(vscode.l10n.t("gitList.initRepoDone", cwd));
        await syncWorkspaceGitRepoContext();
        provider.refresh();
      } catch (err) {
        showGitErrorMessage("gitList.initRepoFailed", err);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.refreshFileHistory", () => provider.refreshFileHistoryList())
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.loadMoreFileHistoryCommits", () =>
      provider.loadMoreFileHistoryCommits()
    )
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      provider.notifyFileHistoryContextChanged();
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const ed = vscode.window.activeTextEditor;
      if (
        ed &&
        doc.uri.scheme === "file" &&
        doc.uri.toString() === ed.document.uri.toString()
      ) {
        provider.maybeRefreshFileHistoryAfterSave(doc);
      }
    }),
    vscode.workspace.onDidRenameFiles((e) => {
      for (const { oldUri, newUri } of e.files) {
        provider.onWorkspaceFileRenamed(oldUri, newUri);
      }
    })
  );

  provider.notifyFileHistoryContextChanged();
  provider.refresh();
  void syncWorkspaceGitRepoContext();

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.refreshCommits", () => provider.refreshCommitsList())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.refreshStash", () => provider.refreshStashList())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.stashAllIncludeUntracked", async () => {
      const repo = await resolveWorkspaceGitRoot();
      if (!repo) {
        void vscode.window.showWarningMessage(vscode.l10n.t("gitList.noGitRepo"));
        return;
      }
      const message = await vscode.window.showInputBox({
        title: vscode.l10n.t("gitList.stashAllUntrackedTitle"),
        prompt: vscode.l10n.t("gitList.stashAllUntrackedPrompt"),
        placeHolder: vscode.l10n.t("gitList.stashAllUntrackedPlaceholder"),
        ignoreFocusOut: true,
      });
      if (message === undefined) {
        return;
      }
      const trimmed = message.trim();
      const args: string[] = ["stash", "push", "-u"];
      if (trimmed.length > 0) {
        args.push("-m", trimmed);
      }
      try {
        await execFileAsync("git", args, {
          cwd: repo,
          maxBuffer: 1024 * 1024,
        });
        void vscode.window.showInformationMessage(vscode.l10n.t("gitList.stashAllUntrackedDone"));
        provider.refreshStashList();
        await vscode.commands.executeCommand("git.refresh").then(
          () => undefined,
          () => undefined
        );
      } catch (err) {
        showGitErrorMessage("gitList.stashAllUntrackedFailed", err);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.refreshBranches", () => provider.refreshBranchesList())
  );

  async function runShowRepoGitStatus(): Promise<void> {
    const repo = await resolveWorkspaceGitRoot();
    if (!repo) {
      void vscode.window.showWarningMessage(vscode.l10n.t("gitList.noGitRepo"));
      return;
    }
    const ch = gitListOutput!;
    ch.clear();
    ch.appendLine(`cwd: ${repo}\n`);
    try {
      const { stdout } = await execFileAsync("git", ["status"], {
        cwd: repo,
        maxBuffer: 1024 * 1024,
      });
      ch.appendLine(stdout.trimEnd());
    } catch (err) {
      ch.appendLine(formatGitExecError(err));
    }
    let state = "";
    try {
      await execFileAsync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], {
        cwd: repo,
        maxBuffer: 4096,
      });
      state += `\n${vscode.l10n.t("gitList.repoStateMergeInProgress")}\n`;
    } catch {
      /* not merging */
    }
    try {
      await execFileAsync("git", ["rev-parse", "-q", "--verify", "REBASE_HEAD"], {
        cwd: repo,
        maxBuffer: 4096,
      });
      state += `\n${vscode.l10n.t("gitList.repoStateRebaseInProgress")}\n`;
    } catch {
      /* not rebasing */
    }
    try {
      await execFileAsync("git", ["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"], {
        cwd: repo,
        maxBuffer: 4096,
      });
      state += `\n${vscode.l10n.t("gitList.repoStateCherryPickInProgress")}\n`;
    } catch {
      /* not cherry-picking */
    }
    if (state) {
      ch.appendLine(state.trimEnd());
    }
    ch.show(true);
    void vscode.window.showInformationMessage(vscode.l10n.t("gitList.repoStatusOpened"));
  }

  async function isCherryPickInProgress(repo: string): Promise<boolean> {
    try {
      await execFileAsync("git", ["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"], {
        cwd: repo,
        maxBuffer: 4096,
      });
      return true;
    } catch {
      return false;
    }
  }

  async function runAbortMerge(): Promise<void> {
    const repo = await resolveWorkspaceGitRoot();
    if (!repo) {
      void vscode.window.showWarningMessage(vscode.l10n.t("gitList.noGitRepo"));
      return;
    }
    if (await isCherryPickInProgress(repo)) {
      void vscode.window.showInformationMessage(vscode.l10n.t("gitList.useAbortCherryPickInstead"));
      return;
    }
    try {
      await execFileAsync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], {
        cwd: repo,
        maxBuffer: 4096,
      });
    } catch {
      void vscode.window.showInformationMessage(vscode.l10n.t("gitList.noMergeInProgress"));
      return;
    }
    const confirm = vscode.l10n.t("gitList.abortMergeConfirmButton");
    const picked = await vscode.window.showWarningMessage(
      vscode.l10n.t("gitList.abortMergeConfirmIntro"),
      { modal: true },
      confirm
    );
    if (picked !== confirm) {
      return;
    }
    try {
      await execFileAsync("git", ["merge", "--abort"], { cwd: repo, maxBuffer: 1024 * 1024 });
      void vscode.window.showInformationMessage(vscode.l10n.t("gitList.abortMergeDone"));
      provider.refresh();
    } catch (err) {
      showGitErrorMessage("gitList.abortMergeFailed", err);
    }
  }

  async function runAbortRebase(): Promise<void> {
    const repo = await resolveWorkspaceGitRoot();
    if (!repo) {
      void vscode.window.showWarningMessage(vscode.l10n.t("gitList.noGitRepo"));
      return;
    }
    try {
      await execFileAsync("git", ["rev-parse", "-q", "--verify", "REBASE_HEAD"], {
        cwd: repo,
        maxBuffer: 4096,
      });
    } catch {
      void vscode.window.showInformationMessage(vscode.l10n.t("gitList.noRebaseInProgress"));
      return;
    }
    const confirm = vscode.l10n.t("gitList.abortRebaseConfirmButton");
    const picked = await vscode.window.showWarningMessage(
      vscode.l10n.t("gitList.abortRebaseConfirmIntro"),
      { modal: true },
      confirm
    );
    if (picked !== confirm) {
      return;
    }
    try {
      await execFileAsync("git", ["rebase", "--abort"], { cwd: repo, maxBuffer: 1024 * 1024 });
      void vscode.window.showInformationMessage(vscode.l10n.t("gitList.abortRebaseDone"));
      provider.refresh();
    } catch (err) {
      showGitErrorMessage("gitList.abortRebaseFailed", err);
    }
  }

  async function runAbortCherryPick(): Promise<void> {
    const repo = await resolveWorkspaceGitRoot();
    if (!repo) {
      void vscode.window.showWarningMessage(vscode.l10n.t("gitList.noGitRepo"));
      return;
    }
    if (!(await isCherryPickInProgress(repo))) {
      void vscode.window.showInformationMessage(vscode.l10n.t("gitList.noCherryPickInProgress"));
      return;
    }
    const confirm = vscode.l10n.t("gitList.abortCherryPickConfirmButton");
    const picked = await vscode.window.showWarningMessage(
      vscode.l10n.t("gitList.abortCherryPickConfirmIntro"),
      { modal: true },
      confirm
    );
    if (picked !== confirm) {
      return;
    }
    try {
      await execFileAsync("git", ["cherry-pick", "--abort"], { cwd: repo, maxBuffer: 1024 * 1024 });
      void vscode.window.showInformationMessage(vscode.l10n.t("gitList.abortCherryPickDone"));
      provider.refresh();
    } catch (err) {
      showGitErrorMessage("gitList.abortCherryPickFailed", err);
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.showRepoGitStatus", () => runShowRepoGitStatus())
  );
  context.subscriptions.push(vscode.commands.registerCommand("gitList.abortMerge", () => runAbortMerge()));
  context.subscriptions.push(vscode.commands.registerCommand("gitList.abortRebase", () => runAbortRebase()));
  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.abortCherryPick", () => runAbortCherryPick())
  );

  type BranchMorePick = vscode.QuickPickItem & { readonly _action: "deleteOld" };

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.openBranchesMoreActions", async () => {
      const items: BranchMorePick[] = [
        {
          label: `$(trash) ${vscode.l10n.t("gitList.branchesMoreDeleteOldTitle")}`,
          description: vscode.l10n.t("gitList.branchesMoreDeleteOldDescription"),
          _action: "deleteOld",
        },
      ];
      const picked = await vscode.window.showQuickPick(items, {
        title: vscode.l10n.t("gitList.branchesMorePickTitle"),
        placeHolder: vscode.l10n.t("gitList.branchesMorePickPlaceholder"),
      });
      if (picked?._action === "deleteOld") {
        await vscode.commands.executeCommand("gitList.deleteBranchesOlderThanSixMonths");
      }
    })
  );

  type CommitListMorePick = vscode.QuickPickItem & { _action?: string };

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.openCommitListMoreActions", async (item?: GitListTreeItem) => {
      const target =
        item instanceof GitListTreeItem
          ? item
          : treeView.selection[0] instanceof GitListTreeItem
            ? treeView.selection[0]
            : undefined;
      if (!target) {
        return;
      }
      const ctx = await provider.resolveCommitListFilterContext(target);
      if (!ctx) {
        void vscode.window.showWarningMessage(vscode.l10n.t("gitList.commitListMoreUnavailable"));
        return;
      }
      const picks: CommitListMorePick[] = [
        {
          label: `$(filter) ${vscode.l10n.t("gitList.commitListFilterParticipantsTitle")}`,
          description: vscode.l10n.t("gitList.commitListFilterParticipantsDesc"),
          _action: "participants",
        },
      ];
      const picked = await vscode.window.showQuickPick(picks, {
        title: vscode.l10n.t("gitList.commitListMorePickTitle"),
        placeHolder: vscode.l10n.t("gitList.commitListMorePickPlaceholder"),
      });
      if (!picked || (picked as CommitListMorePick)._action !== "participants") {
        return;
      }
      await provider.runParticipantFilterQuickPick(ctx.scopeKey, ctx.fireRefresh);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.refreshBranchCommits", (item?: GitListTreeItem) => {
      const target = item ?? treeView.selection[0];
      if (target) {
        provider.refreshBranchCommitsList(target);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.refreshRemotes", async () => {
      const repo = await resolveWorkspaceGitRoot();
      if (!repo) {
        void vscode.window.showWarningMessage(vscode.l10n.t("gitList.noGitRepo"));
        return;
      }
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t("gitList.fetchAllRemotesProgressTitle"),
            cancellable: false,
          },
          async () => {
            await execFileAsync("git", ["fetch", "--all", "--prune"], {
              cwd: repo,
              maxBuffer: 50 * 1024 * 1024,
            });
          }
        );
        provider.refreshRemotesList();
      } catch (err) {
        showGitErrorMessage("gitList.fetchAllRemotesFailed", err);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.refreshRemoteBranches", async (item?: GitListTreeItem) => {
      const target = item ?? treeView.selection[0];
      if (!target || target.kind !== "remote" || !target.remoteName) {
        return;
      }
      const repo = await resolveWorkspaceGitRoot();
      if (!repo) {
        void vscode.window.showWarningMessage(vscode.l10n.t("gitList.noGitRepo"));
        return;
      }
      const rn = target.remoteName;
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t("gitList.fetchOneRemoteProgressTitle", rn),
            cancellable: false,
          },
          async () => {
            await execFileAsync("git", ["fetch", rn, "--prune"], {
              cwd: repo,
              maxBuffer: 50 * 1024 * 1024,
            });
          }
        );
        provider.refreshRemoteBranchesList(target);
      } catch (err) {
        showGitErrorMessage("gitList.fetchOneRemoteFailed", err);
      }
    })
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
    vscode.commands.registerCommand("gitList.loadMoreRemotes", () => provider.loadMoreRemotes())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.loadMoreRemoteBranches", (item?: GitListTreeItem) => {
      const target = item ?? treeView.selection[0];
      if (target) {
        provider.loadMoreRemoteBranches(target);
      }
    })
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
        showGitErrorMessage("gitList.applyStashFailed", err);
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
        showGitErrorMessage("gitList.dropStashFailed", err);
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
      if (target.branchSource === "remote") {
        void vscode.window.showWarningMessage(vscode.l10n.t("gitList.deleteBranchRemoteNotSupported"));
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
        showGitErrorMessage("gitList.deleteBranchFailed", err);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.checkoutBranch", async (item?: GitListTreeItem) => {
      const target = item ?? treeView.selection[0];
      if (!target || target.kind !== "branch" || !target.branchName) {
        void vscode.window.showWarningMessage(vscode.l10n.t("gitList.checkoutBranchPick"));
        return;
      }
      const repo = await resolveWorkspaceGitRoot();
      if (!repo) {
        void vscode.window.showWarningMessage(vscode.l10n.t("gitList.noGitRepo"));
        return;
      }
      let head: string;
      try {
        const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: repo,
          maxBuffer: 64 * 1024,
        });
        head = stdout.trim();
      } catch {
        void vscode.window.showErrorMessage(vscode.l10n.t("gitList.deleteBranchReadHeadFailed"));
        return;
      }
      const name = target.branchName;
      try {
        if (target.branchSource !== "remote") {
          if (head === name) {
            void vscode.window.showInformationMessage(
              vscode.l10n.t("gitList.checkoutBranchAlreadyOn", name)
            );
            return;
          }
          await execFileAsync("git", ["switch", name], {
            cwd: repo,
            maxBuffer: 1024 * 1024,
          });
        } else {
          const slash = name.indexOf("/");
          if (slash < 0) {
            await execFileAsync("git", ["switch", name], {
              cwd: repo,
              maxBuffer: 1024 * 1024,
            });
          } else {
            const shortName = name.slice(slash + 1);
            if (head === shortName) {
              void vscode.window.showInformationMessage(
                vscode.l10n.t("gitList.checkoutBranchAlreadyOn", shortName)
              );
              return;
            }
            try {
              await execFileAsync("git", ["switch", shortName], {
                cwd: repo,
                maxBuffer: 1024 * 1024,
              });
            } catch {
              await execFileAsync("git", ["switch", "-c", shortName, name], {
                cwd: repo,
                maxBuffer: 1024 * 1024,
              });
            }
          }
        }
        void vscode.window.showInformationMessage(
          vscode.l10n.t("gitList.checkoutBranchDone", name)
        );
        provider.refresh();
      } catch (err) {
        showGitErrorMessage("gitList.checkoutBranchFailed", err);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.mergeBranchIntoHead", async (item?: GitListTreeItem) => {
      const target = item ?? treeView.selection[0];
      if (!target || target.kind !== "branch" || !target.branchName) {
        void vscode.window.showWarningMessage(vscode.l10n.t("gitList.mergeBranchPick"));
        return;
      }
      const ref = target.branchName;
      const repo = await resolveWorkspaceGitRoot();
      if (!repo) {
        void vscode.window.showWarningMessage(vscode.l10n.t("gitList.noGitRepo"));
        return;
      }
      let head: string;
      try {
        const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: repo,
          maxBuffer: 64 * 1024,
        });
        head = stdout.trim();
      } catch {
        void vscode.window.showErrorMessage(vscode.l10n.t("gitList.deleteBranchReadHeadFailed"));
        return;
      }
      if (head === "HEAD") {
        void vscode.window.showWarningMessage(vscode.l10n.t("gitList.mergeBranchDetachedHead"));
        return;
      }
      if (target.branchSource !== "remote" && ref === head) {
        void vscode.window.showWarningMessage(vscode.l10n.t("gitList.mergeBranchSameAsHead", ref));
        return;
      }
      const confirm = vscode.l10n.t("gitList.mergeBranchConfirmButton");
      const picked = await vscode.window.showWarningMessage(
        vscode.l10n.t("gitList.mergeBranchConfirmIntro", ref, head),
        { modal: true },
        confirm
      );
      if (picked !== confirm) {
        return;
      }
      try {
        await execFileAsync("git", ["merge", ref], {
          cwd: repo,
          maxBuffer: 50 * 1024 * 1024,
        });
        void vscode.window.showInformationMessage(vscode.l10n.t("gitList.mergeBranchDone", ref));
        provider.refresh();
      } catch (err) {
        showGitErrorMessage("gitList.mergeBranchFailed", err);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.deleteBranchesOlderThanSixMonths", async () => {
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
      const cutoff = cutoffDateMonthsAgo(DELETE_BRANCHES_OLDER_THAN_MONTHS);
      const rows = await listLocalBranchTipDates(repo);
      const toDelete = rows
        .filter((r) => r.name !== currentHead && r.tipDate < cutoff)
        .map((r) => r.name);
      if (toDelete.length === 0) {
        void vscode.window.showInformationMessage(vscode.l10n.t("gitList.deleteOldBranchesNone"));
        return;
      }
      const confirmBtn = vscode.l10n.t("gitList.deleteOldBranchesConfirmButton");
      const picked = await vscode.window.showWarningMessage(
        vscode.l10n.t("gitList.deleteOldBranchesConfirm", String(toDelete.length)),
        { modal: true },
        confirmBtn
      );
      if (picked !== confirmBtn) {
        return;
      }
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: vscode.l10n.t("gitList.deleteOldBranchesProgressTitle"),
          cancellable: false,
        },
        async (progress) => {
          const deleted: string[] = [];
          const failed: string[] = [];
          const total = toDelete.length;
          for (let i = 0; i < toDelete.length; i++) {
            const b = toDelete[i];
            progress.report({
              message: vscode.l10n.t(
                "gitList.deleteOldBranchesProgress",
                b,
                String(i + 1),
                String(total)
              ),
            });
            try {
              await execFileAsync("git", ["branch", "-d", b], {
                cwd: repo,
                maxBuffer: 1024 * 1024,
              });
              deleted.push(b);
            } catch {
              failed.push(b);
            }
          }
          provider.notifyBranchesDeleted(deleted);
          if (failed.length === 0) {
            void vscode.window.showInformationMessage(
              vscode.l10n.t("gitList.deleteOldBranchesSummary", String(deleted.length))
            );
          } else {
            const sample = failed.slice(0, 8).join(", ");
            const more = failed.length > 8 ? "…" : "";
            void vscode.window.showWarningMessage(
              vscode.l10n.t(
                "gitList.deleteOldBranchesPartial",
                String(deleted.length),
                String(failed.length),
                `${sample}${more}`
              )
            );
          }
        }
      );
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
        showGitErrorMessage("gitList.createBranchFailed", err);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.cherryPickCommit", async (item?: GitListTreeItem) => {
      const target = item ?? treeView.selection[0];
      if (!target || target.kind !== "commit" || !target.commitMeta?.fullHash) {
        void vscode.window.showWarningMessage(vscode.l10n.t("gitList.cherryPickPickCommit"));
        return;
      }
      const repo = await resolveWorkspaceGitRoot();
      if (!repo) {
        void vscode.window.showWarningMessage(vscode.l10n.t("gitList.noGitRepo"));
        return;
      }
      const fullHash = target.commitMeta.fullHash.trim();
      const headRef = await readCurrentBranchHeadRef(repo);
      if (!headRef) {
        void vscode.window.showErrorMessage(vscode.l10n.t("gitList.deleteBranchReadHeadFailed"));
        return;
      }
      if (headRef === "HEAD") {
        void vscode.window.showWarningMessage(vscode.l10n.t("gitList.cherryPickDetachedHead"));
        return;
      }
      const branchName = (await readCurrentBranchName(repo)) ?? headRef;
      try {
        const { stdout: headHashOut } = await execFileAsync("git", ["rev-parse", "HEAD"], {
          cwd: repo,
          maxBuffer: 4096,
        });
        if (headHashOut.trim() === fullHash) {
          void vscode.window.showWarningMessage(vscode.l10n.t("gitList.cherryPickAlreadyHead"));
          return;
        }
      } catch {
        void vscode.window.showErrorMessage(vscode.l10n.t("gitList.deleteBranchReadHeadFailed"));
        return;
      }
      if (await isCommitAncestorOfHead(repo, fullHash)) {
        void vscode.window.showWarningMessage(vscode.l10n.t("gitList.cherryPickAlreadyOnBranch"));
        return;
      }
      const subject = typeof target.label === "string" ? target.label : String(target.label);
      const shortHash = fullHash.length > 7 ? fullHash.slice(0, 7) : fullHash;
      const confirmBtn = vscode.l10n.t("gitList.cherryPickConfirmButton");
      const picked = await vscode.window.showWarningMessage(
        vscode.l10n.t(
          "gitList.cherryPickConfirmIntro",
          subject,
          shortHash,
          branchName,
          fullHash
        ),
        { modal: true },
        confirmBtn
      );
      if (picked !== confirmBtn) {
        return;
      }
      try {
        await execFileAsync("git", ["cherry-pick", fullHash], {
          cwd: repo,
          maxBuffer: 1024 * 1024,
        });
        void vscode.window.showInformationMessage(
          vscode.l10n.t("gitList.cherryPickDone", shortHash, branchName)
        );
        provider.refresh();
      } catch (err) {
        showGitErrorMessage("gitList.cherryPickFailed", err);
      }
    })
  );

  function resolveCommitOrStashHashes(
    target: GitListTreeItem
  ): { short: string; long: string } | undefined {
    if (target.kind === "commit") {
      const long = target.commitMeta?.fullHash?.trim();
      if (!long) {
        return undefined;
      }
      const displayed = target.hash?.trim();
      const short =
        displayed && displayed.length < long.length && /^[0-9a-f]+$/i.test(displayed)
          ? displayed
          : long.slice(0, 7);
      return { short, long };
    }
    if (target.kind === "stash") {
      const long = target.hash?.trim();
      if (!long || !/^[0-9a-f]{7,64}$/i.test(long)) {
        return undefined;
      }
      const short = long.length > 7 ? long.slice(0, 7) : long;
      return { short, long };
    }
    return undefined;
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.copyCommitShortHash", async (item?: GitListTreeItem) => {
      const target = item ?? treeView.selection[0];
      const h = target ? resolveCommitOrStashHashes(target) : undefined;
      if (!h) {
        return;
      }
      await vscode.env.clipboard.writeText(h.short);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.copyCommitFullHash", async (item?: GitListTreeItem) => {
      const target = item ?? treeView.selection[0];
      const h = target ? resolveCommitOrStashHashes(target) : undefined;
      if (!h) {
        return;
      }
      await vscode.env.clipboard.writeText(h.long);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.copyHeadBranchName", async () => {
      const repo = await resolveWorkspaceGitRoot();
      if (!repo) {
        void vscode.window.showWarningMessage(vscode.l10n.t("gitList.noGitRepo"));
        return;
      }
      const branchName = await readCurrentBranchName(repo);
      if (!branchName) {
        void vscode.window.showWarningMessage(vscode.l10n.t("gitList.copyHeadReadFailed"));
        return;
      }
      await vscode.env.clipboard.writeText(branchName);
      void vscode.window.showInformationMessage(
        vscode.l10n.t("gitList.copyHeadBranchDone", branchName)
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "gitList.openCursorLineCommitFileDiff",
      async (payload?: { repo?: string; relPath?: string; commitHash?: string } | unknown[]) => {
        const p = (Array.isArray(payload) ? payload[0] : payload) as
          | { repo?: string; relPath?: string; commitHash?: string }
          | undefined;
        const repo = p?.repo?.trim();
        const relPath = p?.relPath?.trim();
        const commitHash = p?.commitHash?.trim();
        if (!repo || !relPath || !commitHash) {
          return;
        }
        try {
          await openCommitFileDiff(repo, relPath, commitHash);
        } catch {
          void vscode.window.showWarningMessage(vscode.l10n.t("gitList.cursorLineOpenCommitDiffFailed"));
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.openPatchFileDiff", async (item?: GitListTreeItem) => {
      if (!item || item.kind !== "patchFile" || !item.repoRoot || !item.relPath) {
        return;
      }
      const repo = item.repoRoot;
      const relPath = item.relPath;
      let left: vscode.Uri;
      let right: vscode.Uri;
      let title: string;

      if (item.stashRef) {
        const rightTip = item.stashRightGitShow ?? `${item.stashRef}:${relPath}`;
        if (item.changeKind === "added") {
          left = makeEmptyDocUri(repo, `empty-before-${relPath}`);
          right = makeGitObjectUri(repo, rightTip, relPath);
        } else if (item.changeKind === "deleted") {
          left = makeGitObjectUri(repo, `${item.stashRef}^1:${relPath}`, relPath);
          right = makeEmptyDocUri(repo, `empty-after-${relPath}`);
        } else {
          left = makeGitObjectUri(repo, `${item.stashRef}^1:${relPath}`, relPath);
          right = makeGitObjectUri(repo, rightTip, relPath);
        }
        title = `${diffPathBasename(relPath)} (${stashRefShortForTitle(item.stashRef)})`;
      } else if (item.hash) {
        const h = item.hash;
        if (item.changeKind === "added") {
          left = makeEmptyDocUri(repo, `empty-before-${relPath}`);
          right = makeGitObjectUri(repo, `${h}:${relPath}`, relPath);
        } else if (item.changeKind === "deleted") {
          left = makeGitObjectUri(repo, `${h}^:${relPath}`, relPath);
          right = makeEmptyDocUri(repo, `empty-after-${relPath}`);
        } else {
          left = makeGitObjectUri(repo, `${h}^:${relPath}`, relPath);
          right = makeGitObjectUri(repo, `${h}:${relPath}`, relPath);
        }
        title = `${diffPathBasename(relPath)} (${shortHashForTitle(h)})`;
      } else {
        return;
      }

      await vscode.commands.executeCommand("vscode.diff", left, right, title, {
        preview: true,
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.openPatchFileInWorkspace", async (item?: GitListTreeItem) => {
      const target = item ?? treeView.selection[0];
      if (!target || target.kind !== "patchFile" || !target.repoRoot || !target.relPath) {
        return;
      }
      const uri = workingTreeFileUri(target.repoRoot, target.relPath);
      try {
        await vscode.window.showTextDocument(uri, { preview: false });
      } catch {
        void vscode.window.showWarningMessage(vscode.l10n.t("gitList.openWorkingTreeFailed"));
      }
    })
  );

  function syncGitListDiffContext(): void {
    let has = false;
    for (const e of vscode.window.visibleTextEditors) {
      if (parseGitListRevUri(e.document.uri)) {
        has = true;
        break;
      }
    }
    void vscode.commands.executeCommand("setContext", "gitList.isGitListDiff", has);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.openWorkingTreeFromDiff", async () => {
      const ordered: vscode.Uri[] = [];
      const pushUri = (u: vscode.Uri): void => {
        const s = u.toString();
        if (!ordered.some((x) => x.toString() === s)) {
          ordered.push(u);
        }
      };
      const active = vscode.window.activeTextEditor?.document.uri;
      if (active) {
        pushUri(active);
      }
      for (const ed of vscode.window.visibleTextEditors) {
        pushUri(ed.document.uri);
      }
      for (const uri of ordered) {
        const p = parseGitListRevUri(uri);
        if (!p) {
          continue;
        }
        const target = workingTreeFileUri(p.repoRoot, p.relPath);
        try {
          await vscode.window.showTextDocument(target, {
            preview: false,
            viewColumn: vscode.ViewColumn.Beside,
          });
          return;
        } catch {
          void vscode.window.showWarningMessage(vscode.l10n.t("gitList.openWorkingTreeFailed"));
          return;
        }
      }
      void vscode.window.showInformationMessage(vscode.l10n.t("gitList.openWorkingTreeNoGitListDoc"));
    }),
    vscode.window.onDidChangeActiveTextEditor(() => syncGitListDiffContext()),
    vscode.window.onDidChangeVisibleTextEditors(() => syncGitListDiffContext())
  );
  syncGitListDiffContext();

  void subscribeBuiltInGitEvents(context, () => provider.refresh());

  registerWorkspaceDotGitWatcher(context, provider);

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      invalidateWorkspaceGitRootCache();
      void syncWorkspaceGitRepoContext();
      provider.refresh();
    })
  );

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

/** 监听工作区 `.git` 创建/删除，手动删仓库后无需依赖刷新按钮。 */
function registerWorkspaceDotGitWatcher(
  context: vscode.ExtensionContext,
  provider: GitListTreeProvider
): void {
  let watcher: vscode.FileSystemWatcher | undefined;

  const resetWatcher = (): void => {
    watcher?.dispose();
    watcher = undefined;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return;
    }
    watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, ".git")
    );
    const onGitPresenceChanged = (): void => {
      invalidateWorkspaceGitRootCache();
      void syncWorkspaceGitRepoContext();
      provider.refresh();
    };
    watcher.onDidCreate(onGitPresenceChanged);
    watcher.onDidDelete(onGitPresenceChanged);
  };

  resetWatcher();
  context.subscriptions.push(
    { dispose: () => watcher?.dispose() },
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      resetWatcher();
    })
  );
}

/** 内置 Git 扩展 API：init / openRepository（注册新仓库，避免 git.refresh 报「无可用存储库」）。 */
interface BuiltInGitRepoApi {
  init?(root: vscode.Uri, options?: { defaultBranch?: string }): Promise<unknown>;
  openRepository?(root: vscode.Uri): Promise<unknown>;
}

async function initWorkspaceGitRepository(folderUri: vscode.Uri): Promise<void> {
  const cwd = folderUri.fsPath;
  const ext = vscode.extensions.getExtension("vscode.git");
  if (ext) {
    try {
      await ext.activate();
      const api = ext.exports?.getAPI?.(1) as BuiltInGitRepoApi | undefined;
      if (api?.init) {
        await api.init(folderUri);
        return;
      }
      await execFileAsync("git", ["init"], { cwd, maxBuffer: 1024 * 1024 });
      if (api?.openRepository) {
        await api.openRepository(folderUri);
        return;
      }
      return;
    } catch {
      /* fall through to plain git init */
    }
  }
  await execFileAsync("git", ["init"], { cwd, maxBuffer: 1024 * 1024 });
}

function repoMatchesAnyWorkspaceFolder(_api: BuiltInGitApi, repo: BuiltInGitRepository): boolean {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    return false;
  }
  const target = normalizeRepoRoot(repo.rootUri.fsPath);
  for (const wf of folders) {
    const wfNorm = normalizeRepoRoot(wf.uri.fsPath);
    if (target === wfNorm || wfNorm.startsWith(`${target}/`) || target.startsWith(`${wfNorm}/`)) {
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
        if (repoMatchesAnyWorkspaceFolder(api, repo)) {
          invalidateWorkspaceGitRootCache();
          void syncWorkspaceGitRepoContext();
          refresh();
        }
        attachRepoStateListener(repo);
      })
    );
    context.subscriptions.push(
      api.onDidCloseRepository((repo) => {
        detachRepoStateListener(repo);
        if (repoMatchesAnyWorkspaceFolder(api, repo)) {
          invalidateWorkspaceGitRootCache();
          void syncWorkspaceGitRepoContext();
          refresh();
        }
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
