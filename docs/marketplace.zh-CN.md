# 将 Git List 发布到 VS Code 应用市场

## 1. 准备 Publisher

1. 使用 Microsoft 账号登录 [Azure DevOps](https://dev.azure.com/)。
2. 打开 [Visual Studio Marketplace 管理页](https://marketplace.visualstudio.com/manage)，创建 **Publisher**。
3. 记下 **Publisher ID**，并写入本仓库根目录 `package.json` 的 `"publisher"` 字段。

## 2. 个人访问令牌（PAT）

1. 打开 [Azure DevOps 用户设置 → Personal access tokens](https://dev.azure.com/_usersSettings/tokens)。
2. 新建令牌：**Scopes** 选择 **Custom defined**，展开 **Marketplace**，勾选 **Manage**。
3. 复制生成的令牌并**妥善保存**（只显示一次）。

## 3. 安装与登录 vsce

项目已包含开发依赖 `@vscode/vsce`。在本仓库根目录执行：

```bash
npx vsce login <你的PublisherID>
```

按提示粘贴 PAT。登录状态会保存在本机，之后同一机器可直接打包、发布。

## 4. 打包与发布

确保已编译且图标已生成：

```bash
npm run package
```

会生成 `git-list-<version>.vsix`。检查无误后发布：

```bash
npx vsce publish
```

或指定版本（遵循 semver）：

```bash
npx vsce publish patch
```

一键：本地先编译并生成图标，再**自动升版本号**并 `vsce publish`（默认升 **patch**）：

```bash
npm run release
# 或 npm run release:minor / npm run release:major
```

在 VS Code 中：**终端 → 运行任务…** → 选 **Release: patch + publish**（或 minor / major）。需已执行过 `npx vsce login`。

## 5. 商店展示说明

- **README**：市场详情页主要展示仓库根目录的 `README.md`，请保持与功能一致；文中外链请与 Gitee 默认分支一致（当前为 `main`）。
- **标题与描述**：Marketplace **不会**把 `package.json` 里的 `%git-list.xxx%` 替换成文案，请直接使用英文 **`displayName`**、**`description`** 字符串（本仓库已如此配置）。
- **图标**：`package.json` 的 `"icon": "media/icon.png"` 为 **128×128** PNG，由 `media/icon.svg` 通过 `npm run render-icon` 生成；修改 SVG 后请重新执行该命令。
- **类目**：当前为 `SCM Providers`，可按需在 `package.json` 的 `categories` 中调整。

## 6. 收款码

- 收款码使用 `media/wechat.png`、`media/alipay.png`；README 中通过 Gitee `raw` 链嵌入图片，替换文件后推送 `main` 即可。

## 7. 常见问题

- **publisher 未改**：`vsce publish` 会失败或发布到错误命名空间，请先修改 `package.json`。
- **PAT 权限不足**：确认 Marketplace **Manage** 已勾选。
- **首次上架审核**：有时需要等待一段时间，以市场提示为准。
