# Git List

A VS Code **activity bar** view for Git repositories in your workspace. Inspect **commits**, **local branches**, **remotes** (remote-tracking branches), and **stashes** in the sidebar. Expand an entry to see changed files; click a file to open a **diff** in the built-in editor. Optional **per-author** colors for commit icons are remembered until you clear them.

![Extension icon](https://gitee.com/liuyuanfan6/git-list/raw/main/media/icon.png)

## Features

| Area | What you get |
|------|----------------|
| **Commits** | Paginated history from `HEAD`, expandable file list, open diff per file. Section-level refresh. |
| **Branches** | Paginated local branches (`git branch`), each branch shows paginated `git log` for that ref. Branches **not merged into current HEAD** use a **red branch icon** (from `git for-each-ref … --no-merged HEAD`); the label is the plain branch name. **Context:** switch to branch (`git switch`), merge into current branch when unmerged (`git merge`), delete local branch (`git branch -d`). **⋯** (right of refresh) opens a **Quick Pick**: **show repository status** (`git status` in the **Git List** output channel), **abort merge** / **abort rebase** (with confirmation when `MERGE_HEAD` / `REBASE_HEAD` exists), and **bulk-delete** locals whose **tip** is older than **6 months** (with progress). |
| **Remotes** | Paginated remote names (`git remote`). Each remote lists remote-tracking branches (`refs/remotes/…`). Same log/diff behavior as Branches; unmerged-into-HEAD styling and **merge** when applicable. **Context:** switch — tries `git switch <name>`, then `git switch -c <name> <remote/ref>` if no local branch exists. Section and per-remote refresh. Section title is plain English (`Remotes`). |
| **Stash** | Paginated stash list, expandable patch tree, open diffs. Apply or drop stash from context menu. |
| **Global** | Refresh button on the view title. Optional auto-refresh when the built-in **Git** extension reports repo or state changes (workspace-scoped). |
| **Author icons** | Command **Git List: Clear Saved Author Icon Colors** resets stored colors for commit avatars. |

## Commands

Commands are also available from the **Command Palette** (`Ctrl+Shift+P` / `Cmd+Shift+P`) unless noted.

| Command | Description | Typical access |
|---------|-------------|----------------|
| **Refresh** | Reload the whole Git List tree. | View title bar |
| **Refresh commits list** | Reset commits paging and refresh **Commits**. | **Commits** section row (inline) |
| **Refresh stash list** | Reset stash paging and refresh **Stash**. | **Stash** section row (inline) |
| **Refresh branch list** | Reset local branch paging and refresh **Branches**. | **Branches** section row (inline, left) |
| **More branch actions…** | Opens a **Quick Pick** on the **Branches** section row (ellipsis **⋯** icon): repository status, abort merge/rebase, and bulk-delete old locals (see **Branches** row above). | **Branches** section row (inline, right of refresh); Command Palette |
| **Git List: Show Repository Status** | Runs `git status`, prints it to **Output → Git List**, and notes merge/rebase-in-progress when detected. | Quick Pick from **More branch actions…**; Command Palette |
| **Git List: Abort Merge** | `git merge --abort` after confirmation (only if a merge is in progress). | Quick Pick from **More branch actions…**; Command Palette |
| **Git List: Abort Rebase** | `git rebase --abort` after confirmation (only if a rebase is in progress). | Quick Pick from **More branch actions…**; Command Palette |
| **Delete local branches older than 6 months…** | Deletes **local** branches whose **tip** committer date is older than 6 months (`git branch -d` each); never deletes the checked-out branch; unmerged branches are left and summarized. Progress in a notification while running. | Quick Pick from **More branch actions…**; Command Palette |
| **Refresh commits under this branch** | Reset commit paging for that branch only. | Local or remote-tracking **branch** row (inline) |
| **Refresh remotes list** | Reset remote-name paging and refresh **Remotes**. | **Remotes** section row (inline) |
| **Refresh branches under this remote** | Reset branch paging under that remote. | **Remote** row (e.g. `origin`, inline) |
| **Git List: Clear Saved Author Icon Colors** | Clear persisted author icon colors. | Command Palette |
| **Create Branch from Commit…** | Create and check out a new branch at the selected commit. | **Commit** row (context) |
| **Apply Stash** | `git stash apply` for the selected entry. | **Stash** row (context) |
| **Drop Stash…** | `git stash drop` after confirmation. | **Stash** row (context) |
| **Switch to This Branch** | **Local:** `git switch <branch>`. **Remote-tracking:** `git switch <shortname>` or create from ref with `git switch -c <shortname> <ref>`. | **Branch** row under **Branches** or **Remotes** (context) |
| **Merge into Current Branch…** | Confirms then runs `git merge <ref>` for branches marked **not fully merged** (red branch icon; local or remote-tracking). Failures show **summary plus Git output** in the notification and the same text in **Output → Git List** (button to open the log). Not offered on detached `HEAD`. | Unmerged **branch** row (context); Command Palette |
| **Delete Branch…** | `git branch -d` for a **local** branch only (remote-tracking rows show a hint to use the server or local list). | Local **branch** row (context) |

**Load more** rows appear when a list has more items than the current page size; each section uses the relevant setting below.

## Configuration

All settings are under **Git List** in VS Code Settings. Range is **1–500** unless noted.

| Setting | Default | Description |
|---------|---------|-------------|
| `git-list.commitsPageSize` | `40` | Commits loaded when **Commits** is expanded and for each **Load more** under the root commit list or under a branch. |
| `git-list.stashPageSize` | `40` | Stashes loaded when **Stash** is expanded and for each **Load more**. |
| `git-list.branchesPageSize` | `40` | Local branches when **Branches** is expanded; remote-tracking branches under each **remote**; **Load more** step in both places. |
| `git-list.remotesPageSize` | `10` | Remote **names** when **Remotes** is expanded and for each **Load more** in that list only (not the branch list under a remote). |

## Requirements

| Requirement | Notes |
|---------------|--------|
| [Git](https://git-scm.com/) | Must be on your `PATH` so the extension can run `git`. |
| VS Code | **1.85** or newer (`engines.vscode` in `package.json`). |
| Built-in **Git** | Recommended: enables smoother auto-refresh when repositories open, close, or change. |

## Usage

1. Open a folder or multi-root workspace that contains a Git repository.
2. Click **Git List** in the **Activity Bar**.
3. Expand **Commits**, **Branches**, **Remotes**, or **Stash**.
4. Expand a commit or stash to see files; click a file to open a diff. Use **Load more** when it appears.
5. Under **Branches** or under a remote, expand a branch to page through its commits the same way.
6. On the **Branches** section row, click **⋯** (right of refresh) for **repository status**, **abort merge/rebase**, or bulk-delete locals whose tip is older than six months.
7. Right-click a **branch** row to **switch**, **merge** (if it is not fully merged into `HEAD` — red branch icon), or **delete** (local only).

### Status bar branch and “!”

If the **built-in Git** extension shows a warning next to the current branch in the **status bar**, the repo often has **dirty state, conflicts, or an unfinished merge/rebase/cherry-pick**. Run **Git List: Show Repository Status** (or **Branches → ⋯ → Show repository status**) to see `git status` in **Output → Git List**; use **abort merge** or **abort rebase** from the same menu only when you intend to cancel that operation.

### Git errors and the **Git List** output channel

When a Git List action fails (merge, checkout, branch delete, stash, etc.), the notification includes **summary and Git output**; the same text is **appended** to **Output → Git List**, and you can open that panel from the notification when offered.

## Sponsor

If this extension is useful to you, you can support further development using the QR codes below (images from the Gitee `main` branch).

| WeChat | Alipay |
| :----: | :----: |
| <img src="https://gitee.com/liuyuanfan6/git-list/raw/main/media/wechat.png" alt="WeChat QR" width="220" /> | <img src="https://gitee.com/liuyuanfan6/git-list/raw/main/media/alipay.png" alt="Alipay QR" width="220" /> |

## Development

```bash
npm install
npm run compile
```

Press **F5** to launch the Extension Development Host. After changing `media/icon.svg`, run `npm run render-icon`.

## Publishing

See the official guide: [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension). Package locally with `npm run package` (produces `git-list-<version>.vsix`). Use plain English `displayName` and `description` in `package.json` for the Marketplace listing.

## License

MIT — see [LICENSE](https://gitee.com/liuyuanfan6/git-list/blob/main/LICENSE).
