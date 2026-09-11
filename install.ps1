<#
.SYNOPSIS
  一键安装 dsh-github-connect 插件（DeepSeek Harness）。

  懒人用法（一行）：
    powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/meiao123/dsh-github-connect/master/install.ps1 | iex"

  高级用法：
    .\install.ps1 -Dir "$HOME\.dsh\plugins\dsh-github-connect" -Profile web

  脚本自动：克隆/更新代码 -> pnpm 安装依赖 -> 注册进 profile（默认 web）
  -> 提示重启。不会自动重启 GUI（避免中断正在运行的会话）。
#>
param(
  [string]$Dir = '',
  [string]$Profile = 'web',
  [switch]$SkipPull
)

$ErrorActionPreference = 'Stop'
$Name = 'dsh-github-connect'
$RepoUrl = 'https://github.com/meiao123/dsh-github-connect.git'

function Die([string]$msg) {
  Write-Host "`n[错误] $msg" -ForegroundColor Red
  exit 1
}

Write-Host "==> 安装 $Name 插件 (profile: $Profile)" -ForegroundColor Cyan

# 1) dsh CLI
$dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
if (-not $dshCmd) { Die '未找到 dsh 命令。请先安装 DeepSeek Harness：npm i -g @deepseek-ai/dsh' }
Write-Host "==> 找到 dsh: $($dshCmd.Source)"

# 2) pnpm（corepack 兜底）
$pnpmCmd = $null
if (Get-Command pnpm -ErrorAction SilentlyContinue) {
  $pnpmCmd = 'pnpm'
} else {
  try {
    $null = & corepack pnpm --version 2>$null
    if ($LASTEXITCODE -eq 0) { $pnpmCmd = 'corepack pnpm' }
  } catch { $pnpmCmd = $null }
}
if (-not $pnpmCmd) { Die '未找到 pnpm。请先安装：npm i -g pnpm' }

# 3) git
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Die '未找到 git，请先安装 Git for Windows' }

# 4) 目标目录（默认 $DSH_HOME/plugins/dsh-github-connect）
$homeDsh = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
if (-not $Dir) { $Dir = Join-Path (Join-Path $homeDsh 'plugins') $Name }
$Dir = [System.IO.Path]::GetFullPath($Dir)

# 5) 克隆 / 更新
if (Test-Path (Join-Path $Dir '.git')) {
  if (-not $SkipPull) {
    Write-Host "==> 更新已有代码: $Dir"
    Push-Location $Dir
    try {
      git pull --ff-only | Out-Host
      if ($LASTEXITCODE -ne 0) {
        Write-Host "  (git pull 失败，改用 OpenSSL TLS 后端重试)" -ForegroundColor Yellow
        git -c http.sslBackend=openssl pull --ff-only | Out-Host
      }
    } catch { Write-Host "  (更新失败，继续使用现有代码)" -ForegroundColor Yellow }
    finally { Pop-Location }
  }
} else {
  Write-Host "==> 克隆仓库到 $Dir"
  New-Item -ItemType Directory -Force -Path (Split-Path $Dir -Parent) | Out-Null
  git clone --depth 1 $RepoUrl $Dir | Out-Host
  if ($LASTEXITCODE -ne 0) {
    # Git for Windows defaults to the schannel TLS backend, which fails on
    # machines behind a TLS-intercepting proxy ("AcquireCredentialsHandle
    # failed: SEC_E_NO_CREDENTIALS") — exactly the setups this plugin targets.
    # Retry once with the OpenSSL backend, which reads the Windows cert store.
    Write-Host "  (克隆失败，改用 OpenSSL TLS 后端重试)" -ForegroundColor Yellow
    if (Test-Path $Dir) { Remove-Item $Dir -Recurse -Force -ErrorAction SilentlyContinue }
    git -c http.sslBackend=openssl clone --depth 1 $RepoUrl $Dir | Out-Host
  }
  if ($LASTEXITCODE -ne 0) { Die "git clone 失败。若网络需要代理：git config --global http.proxy http://127.0.0.1:端口 后重试；若报 schannel/SEC_E_NO_CREDENTIALS，先执行 git config --global http.sslBackend openssl" }
}

# 6) 依赖
Write-Host "==> 安装依赖 (pnpm install)"
Push-Location $Dir
try {
  if ($pnpmCmd -eq 'pnpm') { & pnpm install --no-frozen-lockfile 2>&1 | Out-Host }
  else { & corepack pnpm install --no-frozen-lockfile 2>&1 | Out-Host }
  if ($LASTEXITCODE -ne 0) { Die 'pnpm install 失败，请检查网络后重试' }
} finally { Pop-Location }

# 7) 注册进 profile（重复执行是幂等的）
$linkSpec = 'link:' + ($Dir -replace '\\', '/')
Write-Host "==> 注册进 profile '$Profile'"
& dsh plugin --profile $Profile add $linkSpec 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { Die "注册失败。profile '$Profile' 不存在？可指定其它：.\install.ps1 -Profile <名称>" }

# 8) 完成
Write-Host ""
Write-Host "  ✅ 安装完成！插件已加入 profile '$Profile' 的 bundles。" -ForegroundColor Green
Write-Host "     最后一步：重启 DeepSeek Harness GUI ——"
Write-Host "       1. 完全退出当前 dsh web；"
Write-Host "       2. 重新运行: dsh web"
Write-Host "       3. 刷新页面，对话框左下角出现 GitHub 按钮即成功。"
Write-Host "     卸载：dsh plugin --profile $Profile remove $Name"
