# Git List

**English** · A VS Code sidebar view that lists **recent commits** and **stashes** for Git repositories opened in the workspace. Expand a commit or stash to browse changed files; click a file to open a **diff** in the editor. Optional **per-author icon colors** are remembered until you clear them.

**中文** · 在侧栏展示工作区内 Git 仓库的**提交**与**贮藏**列表；展开后可浏览变更文件，点击文件在编辑器中打开 **diff**。可为作者图标保存颜色，也可一键清除。

![Extension icon](https://gitee.com/liuyuanfan6/git-list/raw/master/media/icon.png)

## Features

- **Commits** tree with paging (`git-list.commitsPageSize`), file list under each commit, inline diff via built-in diff editor.
- **Stash** tree with paging (`git-list.stashPageSize`), same diff behavior for stashed changes.
- **Refresh** from the view title; optional auto-refresh when the built-in Git extension opens or closes a repository.
- **Clear saved author icon colors** command when author/account icon colors should reset.
- **Open Support Page** command opens a local HTML page with sponsor QR codes (WeChat & Alipay).

## Requirements

- [Git](https://git-scm.com/) available on your `PATH`.
- VS Code **1.85** or newer.
- Recommended: built-in **Git** extension enabled (for repository open/close events).

## Usage

1. Open a folder or workspace that contains Git repositories.
2. Click the **Git List** icon in the **Activity Bar**.
3. Expand **Commits** or **Stash**, then open items or use **Load more** when shown.
4. Command Palette: `Git List: Open Support Page` — support / QR page.  
   命令面板：`Git List: 打开支持页面（收款码）`。

## Configuration

| Setting | Default | Description |
|--------|---------|-------------|
| `git-list.commitsPageSize` | `40` | Commits loaded on first expand and per “Load more”. |
| `git-list.stashPageSize` | `40` | Stashes loaded on first expand and per “Load more”. |

## Sponsor / 打赏

- 在线预览（与扩展内打开的页面一致，需仓库已推送）：[support.html](https://gitee.com/liuyuanfan6/git-list/raw/master/docs/support.html)。也可在 VS Code 命令面板执行 **Git List: Open Support Page** 打开本地副本。
- 页面内含微信与支付宝收款码图片（`media/wechat.png`、`media/alipay.png`）。

## Development

```bash
npm install
npm run compile
```

Press **F5** in VS Code to launch the Extension Development Host.

After editing `media/icon.svg`, regenerate the marketplace icon:

```bash
npm run render-icon
```

## Publishing to the Visual Studio Marketplace

See [marketplace.zh-CN.md](https://gitee.com/liuyuanfan6/git-list/blob/master/docs/marketplace.zh-CN.md) for publisher registration, Personal Access Token, and `vsce` steps.

打包扩展：

```bash
npm run package
```

生成 `git-list-0.0.1.vsix`（版本号随 `package.json` 变化）。上架前请将 `package.json` 中的 `publisher` 改为你自己的 [Publisher ID](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#create-a-publisher)。

## License

MIT — see [LICENSE](https://gitee.com/liuyuanfan6/git-list/blob/master/LICENSE).
