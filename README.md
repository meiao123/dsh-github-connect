# dsh-github-connect

便携式 GitHub 连接插件：在 DeepSeek Harness 对话框的**左下方**放一个 GitHub 按钮，
一键让 DeepSeek 等 AI 连接你的 GitHub 账号；连接后，AI 可以直接通过 `github_api`
工具读取和操作你的 GitHub（Issues、PR、仓库、Gist、Actions 等）。

> Portable：连接流程使用 GitHub **OAuth 设备流**（或粘贴 PAT），不需要自建回调
> 服务器，不经过任何第三方中转，令牌只保存在本机插件目录里。整个文件夹拷到
> 另一台机器装上就能用。

## 特性

- **左下角常驻按钮**：composer 工具行左端显示 GitHub 图标 + 连接状态（绿点 = 已连接）。
- **两种连接方式**：
  - OAuth 设备流（推荐）：填你自己的 GitHub OAuth App Client ID → 浏览器打开
    `github.com/login/device` → 输入验证码 → 自动轮询直到授权完成；
  - 粘贴 Personal Access Token（建议 fine-grained PAT）。
- **AI 侧 `github_api` 工具**：连接后，AI 可对 `api.github.com` 发 REST 请求，
  并自动附带 system prompt 引导。
- **本地令牌存储**：`.github-auth.json`（已 gitignore），随时可一键断开。
- 零构建、零运行时框架：host 半是纯 ESM，client 半是纯 `__ModuleLoader__` 模块。

## 安装（极简懒人模式）

**在 DSH 对话里对 AI 说一句话**：

> 请你安装这个插件：https://github.com/meiao123/dsh-github-connect

**或复制下面这一行命令**（Windows，任选其一执行）：

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/meiao123/dsh-github-connect/master/install.ps1 | iex"
```

（macOS / Linux）：

```bash
curl -fsSL https://raw.githubusercontent.com/meiao123/dsh-github-connect/master/install.sh | bash
```

一键脚本会自动完成：**克隆代码 → pnpm 安装依赖 → 注册进 profile（默认 `web`）**。
完成后**重启一次 `dsh web`** 并刷新页面，对话框左下角出现 GitHub 按钮即安装成功。
重复执行是安全的（幂等，会自动更新代码）。

> 高级用法：`install.ps1 -Dir <目录> -Profile <名称>` / `bash install.sh <profile> <dir>`
> 卸载：`dsh plugin --profile web remove dsh-github-connect`

### 手动安装（可选）

```powershell
git clone https://github.com/meiao123/dsh-github-connect.git
cd dsh-github-connect
pnpm install
dsh plugin --profile web add link:<本目录绝对路径>
dsh web
```

验证 composition：

```powershell
dsh --dump-config --profile web   # 应包含 dsh-github-connect 行
```

卸载：

```powershell
dsh plugin --profile web remove dsh-github-connect
# 若不再使用，可删除本目录（内含 .github-auth.json，请先确认）
```

## 网络与代理（跨平台，开箱即用）

插件自带独立的受信网络层（`lib/net.js`，基于 undici），**默认自动走代理**，
无需设置任何环境变量：

- **代理解析顺序**（对每个 GitHub 请求）：
  1. 插件配置 `proxy`（见下）；
  2. 环境变量 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`（含小写形式，macOS/Linux 常见）；
  3. Windows 系统代理（注册表 WinINET 设置，自动读取）；
  4. 都没有 → 直连。
- **NO_PROXY**：环境变量 `NO_PROXY` 与配置项 `noProxy` 都会生效（支持 `*`、
  `host:port`、`.domain` 后缀），默认豁免 `localhost`/`127.0.0.1`。
- **系统 CA 信任**：Windows 从系统证书库导出根证书（缓存 30 天，自动刷新）；
  macOS/Linux 读取标准 CA 包路径（`/etc/ssl/certs/ca-certificates.crt` 等）。
  解决“unable to verify the first certificate”（本地 TLS 拦截代理的根证书
  不在 Node 内置证书库）以及直连被重置的问题。
- 所有步骤失败都优雅回退到 Node 默认 fetch，插件不会因此崩溃。

**手动指定代理**（在 profile 的 `cordis.patch.yml` 里给该行加配置）：

```yaml
- id: dsh-github-connect
  name: dsh-github-connect
  config:
    proxy: http://127.0.0.1:7890   # auto（默认）| direct | http(s)://host:port
    noProxy:                       # 可选：这些主机不走代理
      - localhost
      - 127.0.0.1
```

> 注：`.github-ca-cache.pem` 是本机生成的 CA 缓存（已 gitignore），换机器后
> 会自动重新生成，无需手工处理。

## 使用

1. 点击对话框左下角的 **GitHub** 按钮。
2. 未连接时选择：
   - **设备流登录**：填入 GitHub OAuth App 的 Client ID（在
     [github.com/settings/developers](https://github.com/settings/developers)
     创建；**务必勾选 Enable Device Flow**，回调地址不会被用到，随便填个合法 URL
     即可）。老应用的 ID 是 20 位十六进制（`a1b2c3d4e5f6a7b8c9d0`），现在新注册的
     应用是 20 位 base62（`0v23i1oAZuA2IERUSbdQ`、`Ov23li…`），**两种都支持**；
     按需调整 scopes，点「开始连接」，在打开的页面输入验证码；
   - **粘贴 Token**：填入 fine-grained PAT（建议只授予需要的仓库与权限）。
   - 若该 App 处于 GitHub 对新建应用默认开启的「**Expire user access tokens**」状态，
     建议把 App 的 **Client Secret** 一并填进面板：访问令牌到期前插件会自动用
     refresh token 续期，不会中途掉线。留空也能用，只是到期后需要重新授权。
3. 看到「✓ 已连接」后，直接对话即可，例如：
   - “把我账号里的 open issues 列出来”
   - “给 xxx/yyy 仓库提一个 issue，标题…内容…”
4. 想断开时，面板里点「断开连接」（需二次确认）。

## 安全说明

- 令牌（以及可选的 Client Secret）只保存在本机插件目录下的 `.github-auth.json`，
  除直接发送到 `github.com` / `api.github.com` 外不经过任何其他服务器；
  请勿分享该文件或提交到 git（已 gitignore）。
- 本插件不会向任何第三方上传数据，client↔host 走本机同源路由（带 Origin 校验）。
- 断开连接仅删除本地令牌文件；为保险起见也可在 GitHub 的
  Settings → Applications / Tokens 里直接 revoke。
- PAT 请用最小权限（fine-grained）；OAuth 设备流的 scopes 默认
  `repo gist read:org workflow`，可在面板中修改。

## 目录结构

```
dsh-github-connect/
├── package.json         # 包元数据 + dsh.bundle / dsh.client 声明
├── cordis.patch.yml     # bundle patch 层（insert 一行）
├── lib/
│   ├── index.js         # host 半：设备流 / PAT / 令牌存储 / /dsh-github/* 路由 / github_api 工具
│   ├── net.js           # 跨平台受信网络层：代理解析 + 系统 CA（Windows/macOS/Linux）
│   └── client.js        # browser 半：左下角按钮 + 连接面板（conversation.input.left / overlay）
├── tests/smoke.mjs      # host 半冒烟测试：node tests/smoke.mjs
└── .github-auth.json    # 运行时生成：本地令牌（gitignore）
```

## 常见问题

- **为什么设备流需要我自己的 Client ID？** 为了便携与隐私：插件不内置任何作者的
  OAuth App，授权完全发生在“你的 App ↔ 你的账号”之间。
- **AI 未连接时调用 github_api 会怎样？** 工具返回 401 结构错误，模型会提示你
  先点左下角 GitHub 按钮授权，不会卡死。
- **正确 Token 却报“Token 无效”？** 先看报错里的具体原因：
  - `Bad credentials` → 令牌确实被 GitHub 拒绝（过期/撤销/复制不完整）；
  - `无法连接 GitHub API：UNABLE_TO_VERIFY_LEAF_SIGNATURE` 或
    `ECONNRESET`/`ETIMEDOUT` → 本机有本地 TLS 拦截代理或需要走代理才能访问
    GitHub。插件自带的网络层（`lib/net.js`）会自动读取系统代理与系统证书库，
    重启 `dsh web` 后一般无需任何设置即可用；仍失败时按上面的「网络与代理」
    章节手动配置 `proxy`。
- **填了 Client ID 却说「格式不正确」？** 0.1.0 的本地校验只接受 20 位十六进制，
  而 GitHub 现在发给新注册 OAuth App 的是 base62 形式（如 `0v23i1oAZuA2IERUSbdQ`），
  于是请求还没发出就被拦下了。0.1.1 起两种格式都接受——校验只判断形状，
  ID 是否真实存在由 GitHub 判定。
- **用了一段时间后突然 401、连接掉了？** 说明该 OAuth App 开启了
  「Expire user access tokens」，访问令牌有有效期。0.1.1 起插件会保存 GitHub 下发的
  `refresh_token`，并在到期前自动续期（GitHub 每次续期都会轮换 refresh token，
  插件会同步保存新值）。续期失败时错误信息会说明原因与下一步；也可以在连接面板
  补上 Client Secret，或到 App 设置里关闭该选项。
- **`git clone` 报 `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`？**
  这不是仓库或网络问题，而是 Git for Windows 默认的 schannel TLS 后端在带 TLS 拦截
  代理的机器上拿不到客户端凭据——恰好是本插件要服务的环境。先执行
  `git config --global http.sslBackend openssl` 再重试（只想影响单个仓库就去掉
  `--global`，在该仓库内执行）；本仓库的 `install.ps1` 已内置这个回退，无需手工处理。
- **改代码后如何生效？** 改 client 代码刷新页面即可；改 host（lib/index.js、
  lib/net.js）代码需要重启 `dsh web`（client 入口由 host 启动时扫描，无需前端构建）。

## 版本变更

### 0.1.2

- **修复**：`install.ps1` 在带 TLS 拦截代理的机器上克隆必然失败——Git for Windows
  默认的 schannel 后端报 `schannel: AcquireCredentialsHandle failed:
  SEC_E_NO_CREDENTIALS`，而这正是本插件想服务的网络环境。现在 `git clone` /
  `git pull` 失败时会自动改用 OpenSSL TLS 后端重试一次，并在最终失败时给出明确指引。
- **文档**：常见问题新增该错误的排查方法。

### 0.1.1

- **修复**：本地 Client ID 校验从「20 位十六进制」放宽为「20 位字母数字」，兼容
  GitHub 现在发给新注册 OAuth App 的 base62 Client ID（`0v23i1o…` / `Ov23li…`）；
  `Iv1.` + 16 位的 GitHub App ID 仍然支持。此前这类新应用会在请求发出前就被拒绝。
- **新增**：支持 GitHub 的过期用户令牌（新建 OAuth App 的默认设置）。保存
  `refresh_token` 与到期时间，在访问令牌到期前自动续期，并同步保存 GitHub 每次
  轮换出的新 refresh token；`github_api` 遇到 401 时也会先尝试续期再决定是否断开。
- **新增**：连接面板增加可选的 Client Secret 输入框（仅续期用），已连接视图显示
  访问令牌到期时间与续期状态。
- **修复**：`tests/smoke.mjs` 的「未连接」分支断言 `lastVerifiedAt` 是字符串，而该
  分支实际返回 `null`——在没有凭据文件的干净克隆上必然失败。
- **文档**：OAuth App 创建指引补充 Enable Device Flow 与令牌过期说明；安全说明与
  目录结构里的作者本机路径（`E:\dsh\dsh_my_plugin\`）改为通用描述。
- 仓库地址指向本 fork：`github.com/meiao123/dsh-github-connect`。
