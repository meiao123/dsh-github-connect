# AGENTS.md — 给 AI 助手的工作指引

## 一键安装

用户说「**请你安装这个插件**」或粘贴仓库链接时，直接执行：

- Windows（一条命令，含克隆/依赖/注册）：
  ```powershell
  powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/meiao123/dsh-github-connect/master/install.ps1 | iex"
  ```
- macOS / Linux：
  ```bash
  curl -fsSL https://raw.githubusercontent.com/meiao123/dsh-github-connect/master/install.sh | bash
  ```
- 手动等价步骤：`git clone` → `pnpm install` → `dsh plugin --profile web add link:<绝对路径>`。

**重要**：安装完成后**不要自行重启 GUI**（会中断当前会话）——明确告诉用户：
「重启 `dsh web` 并刷新页面，左下角出现 GitHub 按钮即成功」。

## 架构速览

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | host 半：`/dsh-github/*` 路由（status/device/pat/disconnect）、OAuth 设备流、令牌存储 `.github-auth.json`、`github_api` 模型工具 |
| `lib/client.js` | 浏览器半：composer 左下角 GitHub 按钮 + 居中连接面板（`conversation.input.left` / `conversation.input.overlay`） |
| `lib/net.js` | 跨平台网络层：代理解析（环境变量 → Windows 系统代理 → 配置）与系统 CA（Windows 证书库 / macOS/Linux 标准路径） |
| `install.ps1` / `install.sh` | 一键安装脚本（幂等） |
| `tests/smoke.mjs` | 冒烟测试：`node tests/smoke.mjs`（**绝不破坏已连接状态**，连接存在时自动跳过破坏性用例） |

## 使用与排障

- 连接流程：点左下角 GitHub 按钮 → 设备流（需用户自己的 OAuth App Client ID）或粘贴 fine-grained PAT。
- 连接后 AI 用 `github_api` 工具（method/path/body 调 `api.github.com`）替用户操作 GitHub；
  若返回「GitHub 未连接 / 401」，提示用户先点按钮授权，不要重试。
- 报错定位：`Bad credentials` = 令牌无效；`UNABLE_TO_VERIFY_LEAF_SIGNATURE` 等网络类错误 =
  代理/证书问题，先看 `lib/net.js` 的自动代理逻辑，仍失败再让用户按 README 配置 `proxy`。
- 令牌只存本机 `.github-auth.json`（已 gitignore），排障时不要打印令牌内容。
- Client ID 形状：老 OAuth App = 20 位十六进制；现在新注册的 = 20 位 base62
  （`0v23i1o…` / `Ov23li…`）；GitHub App = `Iv1.` + 16 位。本地只校验形状，
  报「Client ID 格式不正确」是形状不对，不是 App 不存在。
- 令牌生命周期：App 开启「Expire user access tokens」时 GitHub 会下发
  `refresh_token` + `expires_in`，`lib/index.js` 的 `ensureFreshToken` /
  `refreshAccessToken` 会在到期前自动续期（GitHub 每次轮换 refresh token）。
  续期通常需要 App 的 Client Secret（面板可选填）；缺 secret 而续期被拒时，
  让用户补填 secret 或到 App 设置里关闭该选项。

## 改代码后如何生效

- 只改 client（`lib/client.js`）：刷新页面即可（host 会重扫 bundle）。
- 改了 host（`lib/index.js` / `lib/net.js`）：需要重启 `dsh web`。
