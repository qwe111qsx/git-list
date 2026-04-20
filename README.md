# Git List

A VS Code **activity bar** view for Git repositories in your workspace. Inspect **commits**, **file history** for the active editor file, **local branches**, **remotes** (remote-tracking branches), and **stashes** in the sidebar. Expand an entry to see changed files; click a file to open a **diff** in the built-in editor. In normal **file** editors, the **active line** can show an inline hint after the line: **current branch**, **git blame author**, and **last-change time** for that line (toggle with `git-list.showCursorLineGitHint`). You can **preload** blame for the first **N** lines per file (`git-list.cursorLineGitHintPreloadMaxLines`, default `400`) so moving the caret inside that range stays fast; set **`0`** to disable preloading and blame only the current line on demand. Optional **per-author** colors for commit icons are remembered until you clear them.

**Author note:** The capabilities here are ones I use regularly in my day-to-day work. If you need extra features or changes, email [949257333@qq.com](mailto:949257333@qq.com).

![Extension icon](https://gitee.com/liuyuanfan6/git-list/raw/main/media/icon.png)

## Features

| Area | What you get |
|------|----------------|
| **Commits** | Paginated history from `HEAD`, expandable file list, open diff per file. Section-level refresh. |
| **File History** | Collapsible section (title is fixed English **File History** / **File History (name)**) listing commits for a **pinned source file** (last focused `file://` file in a repo). Switching to a **diff** or other non-file editor does **not** change the list—only focusing another source file, **rename** of that file, **save** of that file, or **refresh** updates it. Uses **`git log --all --follow`** (same paging as **Commits** via `git-list.commitsPageSize`). Expand commits to browse files / open diffs like **Commits**. |
| **Branches** | Paginated local branches (`git branch`), each branch shows paginated `git log` for that ref. Branches **not merged into current HEAD** use a **red branch icon** (from `git for-each-ref … --no-merged HEAD`); the label is the plain branch name. **Context:** switch to branch (`git switch`), merge into current branch when unmerged (`git merge`), delete local branch (`git branch -d`). **⋯** (right of refresh) opens a **Quick Pick**: **show repository status** (`git status` in the **Git List** output channel), **abort merge** / **abort rebase** (with confirmation when `MERGE_HEAD` / `REBASE_HEAD` exists), and **bulk-delete** locals whose **tip** is older than **6 months** (with progress). |
| **Remotes** | Paginated remote names (`git remote`). Each **remote** row shows **(N)** after the name — number of `refs/remotes/<name>/…` tracking branches (same scope as the list when expanded). Local **branch** rows show the tip **date** on the right instead. Each remote lists remote-tracking branches (`refs/remotes/…`). Same log/diff behavior as Branches; unmerged-into-HEAD styling and **merge** when applicable. **Context:** switch — tries `git switch <name>`, then `git switch -c <name> <remote/ref>` if no local branch exists. **Refresh** runs **`git fetch --all --prune`** (section) or **`git fetch <remote> --prune`** (per remote), then reloads the list. Section title is plain English (`Remotes`). |
| **Stash** | Paginated stash list, expandable patch tree, open diffs. Apply or drop stash from context menu. |
| **Global** | Refresh button on the view title. Optional auto-refresh when the built-in **Git** extension reports repo or state changes (workspace-scoped). |
| **Editor** | After the caret line in tracked **workspace files**, optional text: **branch · author · time** from `git blame` (debounced; can be disabled in settings). Optional **preload** of blame for the first **N** lines (one `git blame` range per file) to speed up caret moves; lines beyond **N** are still blamed on demand. |
| **Diff from Git List** | When you open a commit/stash **file diff** from Git List, the diff editor’s **title bar** can show **Open working tree file** — opens the **current checkout** copy of that path on disk (beside the diff) so you can compare with the revision side by side. |
| **Author icons** | Command **Git List: Clear Saved Author Icon Colors** resets stored colors for commit avatars. |

## Commands

Commands are also available from the **Command Palette** (`Ctrl+Shift+P` / `Cmd+Shift+P`) unless noted.

| Command | Description | Typical access |
|---------|-------------|----------------|
| **Refresh** | Reload the whole Git List tree. | View title bar |
| **Refresh commits list** | Reset commits paging and refresh **Commits**. | **Commits** section row (inline) |
| **Refresh file history** | Reset paging and reload **File History** for the active file. | **File History** section row (inline) |
| **Open working tree file** | From a Git List **file diff** tab, opens the same relative path in the working tree (current branch checkout on disk). | Diff editor title bar (when the diff is from Git List) |
| **Open workspace file** | Opens the **on-disk** file for a **patch file** row under a commit or stash (inline **file** icon on the right). | **Patch file** row under a commit/stash (inline) |
| **Refresh stash list** | Reset stash paging and refresh **Stash**. | **Stash** section row (inline) |
| **Refresh branch list** | Reset local branch paging and refresh **Branches**. | **Branches** section row (inline, left) |
| **More branch actions…** | Opens a **Quick Pick** on the **Branches** section row (ellipsis **⋯** icon): repository status, abort merge/rebase, and bulk-delete old locals (see **Branches** row above). | **Branches** section row (inline, right of refresh); Command Palette |
| **Git List: Show Repository Status** | Runs `git status`, prints it to **Output → Git List**, and notes merge/rebase-in-progress when detected. | Quick Pick from **More branch actions…**; Command Palette |
| **Git List: Abort Merge** | `git merge --abort` after confirmation (only if a merge is in progress). | Quick Pick from **More branch actions…**; Command Palette |
| **Git List: Abort Rebase** | `git rebase --abort` after confirmation (only if a rebase is in progress). | Quick Pick from **More branch actions…**; Command Palette |
| **Delete local branches older than 6 months…** | Deletes **local** branches whose **tip** committer date is older than 6 months (`git branch -d` each); never deletes the checked-out branch; unmerged branches are left and summarized. Progress in a notification while running. | Quick Pick from **More branch actions…**; Command Palette |
| **Refresh commits under this branch** | Reset commit paging for that branch only. | Local or remote-tracking **branch** row (inline) |
| **Fetch all remotes and refresh list** | Runs **`git fetch --all --prune`**, then resets paging and refreshes **Remotes**. | **Remotes** section row (inline) |
| **Fetch this remote and refresh branches** | Runs **`git fetch <remote> --prune`**, then resets branch paging under that remote. | **Remote** row (e.g. `origin`, inline) |
| **Git List: Clear Saved Author Icon Colors** | Clear persisted author icon colors. | Command Palette |
| **Create Branch from Commit…** | Create and check out a new branch at the selected commit. | **Commit** row (context) |
| **Apply Stash** | `git stash apply` for the selected entry. | **Stash** row (context) |
| **Drop Stash…** | `git stash drop` after confirmation. | **Stash** row (context) |
| **Switch to This Branch** | **Local:** `git switch <branch>`. **Remote-tracking:** `git switch <shortname>` or create from ref with `git switch -c <shortname> <ref>`. | **Branch** row under **Branches** or **Remotes** (context) |
| **Merge into Current Branch…** | Confirms then runs `git merge <ref>` for branches marked **not fully merged** (red branch icon; local or remote-tracking). Failures show **summary plus Git output** in the notification and the same text in **Output → Git List** (button to open the log). Not offered on detached `HEAD`. | Unmerged **branch** row (context); Command Palette |
| **Delete Branch…** | `git branch -d` for a **local** branch only (remote-tracking rows show a hint to use the server or local list). | Local **branch** row (context) |

**Load more** rows appear when a list has more items than the current page size; each section uses the relevant setting below.

## Configuration

All settings are under **Git List** in VS Code Settings. Page-size options use range **1–500**; the preload cap uses **0–20000**.

| Setting | Default | Description |
|---------|---------|-------------|
| `git-list.commitsPageSize` | `40` | Commits loaded when **Commits** or **File History** is expanded and for each **Load more** in those lists (also under a branch). |
| `git-list.stashPageSize` | `40` | Stashes loaded when **Stash** is expanded and for each **Load more**. |
| `git-list.branchesPageSize` | `40` | Local branches when **Branches** is expanded; remote-tracking branches under each **remote**; **Load more** step in both places. |
| `git-list.remotesPageSize` | `10` | Remote **names** when **Remotes** is expanded and for each **Load more** in that list only (not the branch list under a remote). |
| `git-list.showCursorLineGitHint` | `true` | When enabled, append **current branch**, **blame author**, and **author time** after the active line in file editors inside a Git repo. |
| `git-list.cursorLineGitHintPreloadMaxLines` | `400` | Preload `git blame` for the first **N** lines of each file (`N` = min(line count, this value)). **`0`** disables preloading (only the active line is blamed when needed). Max **20000**. |

## Requirements

| Requirement | Notes |
|---------------|--------|
| [Git](https://git-scm.com/) | Must be on your `PATH` so the extension can run `git`. |
| VS Code | **1.74** or newer (`engines.vscode` in `package.json`; `onStartupFinished` activates editor hints without opening the sidebar first). |
| Built-in **Git** | Recommended: enables smoother auto-refresh when repositories open, close, or change. |

## Usage

1. Open a folder or multi-root workspace that contains a Git repository.
2. (Optional) Open a source file: with `git-list.showCursorLineGitHint` on (default), moving the caret updates the **branch · author · time** hint at the end of that line. When `git-list.cursorLineGitHintPreloadMaxLines` is not **`0`** (default **`400`**), blame for the first **N** lines is prefetched so jumping within that range is quicker; editing the file clears the cached blame for that path.
3. Click **Git List** in the **Activity Bar**.
4. Expand **Commits**, **File History**, **Branches**, **Remotes**, or **Stash**.
5. Open a tracked source file, then expand **File History** to see commits for that path; focusing another source file changes the pinned file—opening a **diff** alone does not. Expand a commit or stash to see files; click a file to open a diff. Use **Load more** when it appears.
6. Under **Branches** or under a remote, expand a branch to page through its commits the same way.
7. On the **Branches** section row, click **⋯** (right of refresh) for **repository status**, **abort merge/rebase**, or bulk-delete locals whose tip is older than six months.
8. Right-click a **branch** row to **switch**, **merge** (if it is not fully merged into `HEAD` — red branch icon), or **delete** (local only).

### Status bar branch and “!”

If the **built-in Git** extension shows a warning next to the current branch in the **status bar**, the repo often has **dirty state, conflicts, or an unfinished merge/rebase/cherry-pick**. Run **Git List: Show Repository Status** (or **Branches → ⋯ → Show repository status**) to see `git status` in **Output → Git List**; use **abort merge** or **abort rebase** from the same menu only when you intend to cancel that operation.

### Git errors and the **Git List** output channel

When a Git List action fails (merge, checkout, branch delete, stash, **fetch**, etc.), the notification includes **summary and Git output**; the same text is **appended** to **Output → Git List**, and you can open that panel from the notification when offered.

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
