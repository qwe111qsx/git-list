# Git List

**English** · A VS Code sidebar view that lists **recent commits** and **stashes** for Git repositories opened in the workspace. Expand a commit or stash to browse changed files; click a file to open a **diff** in the editor. Optional **per-author icon colors** are remembered until you clear them.

**中文** · 在侧栏展示工作区内 Git 仓库的**提交**与**贮藏**列表；展开后可浏览变更文件，点击文件在编辑器中打开 **diff**。可为作者图标保存颜色，也可一键清除。

![Extension icon](https://gitee.com/liuyuanfan6/git-list/raw/main/media/icon.png)

## Features

- **Commits** tree with paging (`git-list.commitsPageSize`), file list under each commit, inline diff via built-in diff editor.
- **Stash** tree with paging (`git-list.stashPageSize`), same diff behavior for stashed changes.
- **Refresh** from the view title; optional auto-refresh when the built-in Git extension opens or closes a repository.
- **Clear saved author icon colors** command when author/account icon colors should reset.

## Requirements

- [Git](https://git-scm.com/) available on your `PATH`.
- VS Code **1.85** or newer.
- Recommended: built-in **Git** extension enabled (for repository open/close events).

## Usage

1. Open a folder or workspace that contains Git repositories.
2. Click the **Git List** icon in the **Activity Bar**.
3. Expand **Commits** or **Stash**, then open items or use **Load more** when shown.

## Configuration

| Setting | Default | Description |
|--------|---------|-------------|
| `git-list.commitsPageSize` | `40` | Commits loaded on first expand and per “Load more”. |
| `git-list.stashPageSize` | `40` | Stashes loaded on first expand and per “Load more”. |

## Sponsor / 打赏

若本扩展对你有帮助，欢迎扫码支持后续开发（以下为 Gitee `main` 分支上的图片，市场页与网页均可直接显示）。

| 微信 WeChat | 支付宝 Alipay |
| :---------: | :-----------: |
| <img src="https://gitee.com/liuyuanfan6/git-list/raw/main/media/wechat.png" alt="微信收款码" width="220" /> | <img src="https://gitee.com/liuyuanfan6/git-list/raw/main/media/alipay.png" alt="支付宝收款码" width="220" /> |

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

See [marketplace.zh-CN.md](https://gitee.com/liuyuanfan6/git-list/blob/main/docs/marketplace.zh-CN.md) for publisher registration, Personal Access Token, and `vsce` steps.

打包扩展：

```bash
npm run package
```

生成 `git-list-<version>.vsix`（版本号见 `package.json`）。**商店标题与简介**请使用 `package.json` 中的英文 `displayName` / `description`（Marketplace 不会解析 `package.nls` 里的占位符）；侧栏与命令的文案仍由 `package.nls*.json` 做界面级本地化。

## License

MIT — see [LICENSE](https://gitee.com/liuyuanfan6/git-list/blob/main/LICENSE).
