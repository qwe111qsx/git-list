# 将 Git List 发布到 VS Code 应用市场

## 1. 准备 Publisher

1. 使用 Microsoft 账号登录 [Azure DevOps](https://dev.azure.com/)。
2. 打开 [Visual Studio Marketplace 管理页](https://marketplace.visualstudio.com/manage)，创建 **Publisher**。
3. 记下 **Publisher ID**，并写入本仓库根目录 `package.json` 的 `"publisher"` 字段（当前示例为 `"local"`，发布前必须改成你的 ID）。

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

## 5. 商店展示说明

- **README**：市场详情页主要展示仓库根目录的 `README.md`，请保持与功能一致。
- **图标**：`package.json` 的 `"icon": "media/icon.png"` 为 **128×128** PNG，由 `media/icon.svg` 通过 `npm run render-icon` 生成；修改 SVG 后请重新执行该命令。
- **类目**：当前为 `SCM Providers`，可按需在 `package.json` 的 `categories` 中调整。

## 6. 支持页与收款码

- 扩展内命令「Git List: 打开支持页面」会打开 `docs/support.html`。
- 收款码图片路径：`media/wechat.png`、`media/alipay.png`，替换为你的二维码文件即可（建议保持文件名不变，或同步修改 `docs/support.html` 中的 `img` 路径）。

## 7. 常见问题

- **publisher 未改**：`vsce publish` 会失败或发布到错误命名空间，请先修改 `package.json`。
- **PAT 权限不足**：确认 Marketplace **Manage** 已勾选。
- **首次上架审核**：有时需要等待一段时间，以市场提示为准。
