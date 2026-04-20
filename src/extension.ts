import * as vscode from "vscode";
import { execFile } from "child_process";
import { promisify } from "util";
import { clearAuthorStylesStore } from "./authorStyles";
import { registerCursorLineGitHint } from "./cursorLineGitHint";
import { GitListTreeItem, GitListTreeProvider, resolveWorkspaceGitRoot } from "./gitListTreeProvider";
import { makeEmptyDocUri, makeGitObjectUri, registerGitListDocumentProvider } from "./gitShowDocumentProvider";

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

/** 注册侧栏树视图、命令，并在可用时订阅内置 Git 的仓库开关事件以刷新列表。 */
export function activate(context: vscode.ExtensionContext): void {
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

  type BranchMoreAction = "gitStatus" | "abortMerge" | "abortRebase" | "deleteOld";
  type BranchMorePick = vscode.QuickPickItem & { readonly _action: BranchMoreAction };

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
    if (state) {
      ch.appendLine(state.trimEnd());
    }
    ch.show(true);
    void vscode.window.showInformationMessage(vscode.l10n.t("gitList.repoStatusOpened"));
  }

  async function runAbortMerge(): Promise<void> {
    const repo = await resolveWorkspaceGitRoot();
    if (!repo) {
      void vscode.window.showWarningMessage(vscode.l10n.t("gitList.noGitRepo"));
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

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.showRepoGitStatus", () => runShowRepoGitStatus())
  );
  context.subscriptions.push(vscode.commands.registerCommand("gitList.abortMerge", () => runAbortMerge()));
  context.subscriptions.push(vscode.commands.registerCommand("gitList.abortRebase", () => runAbortRebase()));

  context.subscriptions.push(
    vscode.commands.registerCommand("gitList.openBranchesMoreActions", async () => {
      const items: BranchMorePick[] = [
        {
          label: `$(list-flat) ${vscode.l10n.t("gitList.branchesMoreGitStatusTitle")}`,
          description: vscode.l10n.t("gitList.branchesMoreGitStatusDesc"),
          _action: "gitStatus",
        },
        {
          label: `$(debug-disconnect) ${vscode.l10n.t("gitList.branchesMoreAbortMergeTitle")}`,
          description: vscode.l10n.t("gitList.branchesMoreAbortMergeDesc"),
          _action: "abortMerge",
        },
        {
          label: `$(debug-disconnect) ${vscode.l10n.t("gitList.branchesMoreAbortRebaseTitle")}`,
          description: vscode.l10n.t("gitList.branchesMoreAbortRebaseDesc"),
          _action: "abortRebase",
        },
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
      const act = picked ? (picked as BranchMorePick)._action : undefined;
      if (act === "deleteOld") {
        await vscode.commands.executeCommand("gitList.deleteBranchesOlderThanSixMonths");
      } else if (act === "gitStatus") {
        await runShowRepoGitStatus();
      } else if (act === "abortMerge") {
        await runAbortMerge();
      } else if (act === "abortRebase") {
        await runAbortRebase();
      }
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
