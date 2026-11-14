<#
.SYNOPSIS
CoreFeed × Hermes Agent 技能 Windows PowerShell 一键安装脚本 (integrations/hermes-skill/install.ps1)
支持 Windows 原生 ~/.hermes 安装，并自动检测本机 WSL2 中的 ~/.hermes 同步安装。
#>
param(
    [string]$CoreFeedUrl = "",
    [string]$XiaoAiUrl = "",
    [string]$HermesHome = "",
    [switch]$SkipCheck
)

$ErrorActionPreference = "Stop"

$RawSkillBase = if ($env:COREFEED_RAW_SKILL_BASE) {
    $env:COREFEED_RAW_SKILL_BASE
} else {
    "https://raw.githubusercontent.com/alanhsun/CoreFeed/main/integrations/hermes-skill/corefeed-news"
}

$ResolvedHermesHome = if ($HermesHome) {
    $HermesHome
} elseif ($env:HERMES_HOME) {
    $env:HERMES_HOME
} else {
    Join-Path $HOME ".hermes"
}

$DestSkillDir = Join-Path $ResolvedHermesHome "skills\corefeed-news"
$DestScriptsDir = Join-Path $DestSkillDir "scripts"
$EnvFile = Join-Path $ResolvedHermesHome ".env"
$SkillEnvFile = Join-Path $DestSkillDir ".env"

New-Item -ItemType Directory -Force -Path $DestScriptsDir | Out-Null

$LocalSkillDir = if ($PSScriptRoot) { Join-Path $PSScriptRoot "corefeed-news" } else { "" }
$SkillMdDest = Join-Path $DestSkillDir "SKILL.md"
$CliPyDest = Join-Path $DestScriptsDir "corefeed_cli.py"

if ($LocalSkillDir -and (Test-Path (Join-Path $LocalSkillDir "SKILL.md")) -and (Test-Path (Join-Path $LocalSkillDir "scripts\corefeed_cli.py"))) {
    Copy-Item -Force (Join-Path $LocalSkillDir "SKILL.md") $SkillMdDest
    Copy-Item -Force (Join-Path $LocalSkillDir "scripts\corefeed_cli.py") $CliPyDest
} else {
    Invoke-WebRequest -UseBasicParsing -Uri "$RawSkillBase/SKILL.md" -OutFile $SkillMdDest
    Invoke-WebRequest -UseBasicParsing -Uri "$RawSkillBase/scripts/corefeed_cli.py" -OutFile $CliPyDest
}

# 若 Windows 本机只有 python 而无 python3，自动适配 SKILL.md 中的命令前缀
$PythonCmd = $null
if (Get-Command python3 -ErrorAction SilentlyContinue) {
    $PythonCmd = "python3"
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
    $PythonCmd = "python"
}
if ($PythonCmd -eq "python") {
    $NormalizedCliPath = ($CliPyDest -replace "\\", "/")
    $SkillText = [System.IO.File]::ReadAllText($SkillMdDest, [System.Text.Encoding]::UTF8)
    $SkillText = $SkillText.Replace("python3 ~/.hermes/skills/corefeed-news/scripts/corefeed_cli.py", "python `"$NormalizedCliPath`"")
    [System.IO.File]::WriteAllText($SkillMdDest, $SkillText, (New-Object System.Text.UTF8Encoding($false)))
}

function Set-DotEnvKey {
    param(
        [string]$FilePath,
        [string]$Key,
        [string]$Value
    )
    if ([string]::IsNullOrWhiteSpace($Value)) { return }
    $ParentDir = Split-Path -Parent $FilePath
    if ($ParentDir -and -not (Test-Path $ParentDir)) {
        New-Item -ItemType Directory -Force -Path $ParentDir | Out-Null
    }
    $Lines = @()
    if (Test-Path $FilePath) {
        $Lines = [System.IO.File]::ReadAllLines($FilePath, [System.Text.Encoding]::UTF8)
    }
    $Found = $false
    $Updated = foreach ($Line in $Lines) {
        if ($Line -match "^\s*(export\s+)?$([regex]::Escape($Key))=") {
            $Found = $true
            "$Key=`"$Value`""
        } else {
            $Line
        }
    }
    if (-not $Found) {
        $Updated += "$Key=`"$Value`""
    }
    [System.IO.File]::WriteAllLines($FilePath, $Updated, (New-Object System.Text.UTF8Encoding($false)))
}

if ($CoreFeedUrl) {
    Set-DotEnvKey -FilePath $EnvFile -Key "COREFEED_BASE_URL" -Value $CoreFeedUrl
    Set-DotEnvKey -FilePath $SkillEnvFile -Key "COREFEED_BASE_URL" -Value $CoreFeedUrl
}
if ($XiaoAiUrl) {
    Set-DotEnvKey -FilePath $EnvFile -Key "OPENXIAOAI_BASE_URL" -Value $XiaoAiUrl
    Set-DotEnvKey -FilePath $SkillEnvFile -Key "OPENXIAOAI_BASE_URL" -Value $XiaoAiUrl
}

Write-Host "✅ 已安装 Hermes 技能至 Windows 目录: $DestSkillDir"
if ($CoreFeedUrl -or $XiaoAiUrl) {
    Write-Host "✅ 已写入环境变量: $EnvFile"
}

# 若未强制指定 -HermesHome 且本机装有 WSL2，检测 WSL 内是否存在 ~/.hermes 并自动同步安装
if (-not $HermesHome -and (Get-Command wsl -ErrorAction SilentlyContinue)) {
    try {
        $WslCheck = wsl sh -c 'if [ -d "$HOME/.hermes" ]; then printf "yes"; fi' 2>$null
        if ($WslCheck -eq "yes") {
            $InstallShUrl = "https://raw.githubusercontent.com/alanhsun/CoreFeed/main/integrations/hermes-skill/install.sh"
            $WslArgs = "--skip-check"
            if ($CoreFeedUrl) { $WslArgs += " --corefeed-url '$CoreFeedUrl'" }
            if ($XiaoAiUrl) { $WslArgs += " --xiaoai-url '$XiaoAiUrl'" }
            wsl sh -c "wget -qO /tmp/cf-hermes-install.sh '$InstallShUrl' 2>/dev/null || curl -fsSL '$InstallShUrl' -o /tmp/cf-hermes-install.sh; sh /tmp/cf-hermes-install.sh $WslArgs; rm -f /tmp/cf-hermes-install.sh"
            Write-Host "✅ 检测到 WSL2 中的 ~/.hermes，已完成同步安装"
        }
    } catch {
        # Ignore WSL inactive errors
    }
}

if (-not $SkipCheck -and $PythonCmd) {
    Write-Host "--- 连通性自检 ---"
    $env:HERMES_HOME = $ResolvedHermesHome
    & $PythonCmd $CliPyDest status
}
