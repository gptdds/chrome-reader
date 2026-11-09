# Windows PowerShell 5.1; current-user registration, no administrator required.
$ErrorActionPreference = 'Stop'
$HostName = 'com.xiaoxiao.reader'
$ExtensionId = 'dalmdgpohkfpclknkcfpeifdminlijic'
function Get-DirectoryTarget([string]$Path) {
    $Item = Get-Item -LiteralPath $Path -Force
    $Target = $Item.FullName
    if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        if ($Item.LinkType -ne 'Junction') {
            throw '安装入口必须为本机目录或目录联接。'
        }
        $Target = [string](@($Item.Target)[0])
        if (-not [System.IO.Path]::IsPathRooted($Target)) {
            $Target = Join-Path $Item.Parent.FullName $Target
        }
    }
    return [System.IO.Path]::GetFullPath($Target).TrimEnd('\')
}
$ProjectRoot = Get-DirectoryTarget $PSScriptRoot
$StableRoot = Join-Path $env:LOCALAPPDATA 'XiaoxiaoReader'

foreach ($RelativePath in @('.venv\Scripts\python.exe', '.venv\Scripts\pythonw.exe', 'native_host.py', 'native-host.cmd', 'server.py')) {
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot $RelativePath) -PathType Leaf)) {
        throw ('安装文件不完整：' + $RelativePath)
    }
}
$StableItem = Get-Item -LiteralPath $StableRoot -Force -ErrorAction SilentlyContinue
if ($null -eq $StableItem) {
    New-Item -ItemType Junction -Path $StableRoot -Target $ProjectRoot | Out-Null
}
$StableItem = Get-Item -LiteralPath $StableRoot -Force
if ($StableItem.LinkType -ne 'Junction' -or (Get-DirectoryTarget $StableRoot) -ine $ProjectRoot) {
    throw 'XiaoxiaoReader 稳定入口未指向当前项目。未更改现有入口，请修复目录联接后重新安装。'
}
# Validate exactly the executable entry Chrome will use, including its venv.
foreach ($RelativePath in @('native_host.py', 'native-host.cmd', 'server.py', '.venv\Scripts\python.exe', '.venv\Scripts\pythonw.exe')) {
    $SourcePath = Join-Path $ProjectRoot $RelativePath
    $LinkedPath = Join-Path $StableRoot $RelativePath
    if (-not (Test-Path -LiteralPath $LinkedPath -PathType Leaf)) {
        throw 'XiaoxiaoReader 稳定入口指向旧目录。请修复该目录联接后重新安装。'
    }
    if ((Get-FileHash -LiteralPath $SourcePath -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $LinkedPath -Algorithm SHA256).Hash) {
        throw 'XiaoxiaoReader 稳定入口与当前项目不一致，未更改现有入口。'
    }
}

$PythonPath = Join-Path $StableRoot '.venv\Scripts\python.exe'
$HostScript = Join-Path $StableRoot 'native_host.py'
& $PythonPath -I -B -c 'import aiohttp, edge_tts'
if ($LASTEXITCODE -ne 0) {
    throw 'Python 环境缺少语音依赖。请先在项目虚拟环境中安装 requirements.txt。'
}

$Manifest = [ordered]@{
    name = $HostName
    description = 'Start the local Xiaoxiao Reader speech service'
    path = Join-Path $StableRoot 'native-host.cmd'
    type = 'stdio'
    allowed_origins = @('chrome-extension://' + $ExtensionId + '/')
}
$ManifestPath = Join-Path $StableRoot 'native-host.json'
$Utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($ManifestPath, ($Manifest | ConvertTo-Json -Depth 4), $Utf8)
$RegistryKey = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\' + $HostName
New-Item -Path $RegistryKey -Force | Out-Null
Set-Item -LiteralPath $RegistryKey -Value $ManifestPath
$RegisteredPath = (Get-Item -LiteralPath $RegistryKey).GetValue('')
if ($RegisteredPath -ne $ManifestPath) {
    throw 'Chrome 本机启动程序注册校验失败。'
}
Write-Host '已为当前用户配置扩展内启动功能，无需管理员权限。'

$ResultText = & $PythonPath -I -B $HostScript --start-service
if ($LASTEXITCODE -ne 0) {
    throw '本机启动程序无法运行，请检查 Python 环境。'
}
$Result = $ResultText | ConvertFrom-Json
if (-not $Result.ok) {
    throw $Result.error
}
Write-Host '本机语音服务已就绪。'
Write-Host '请打开 chrome://extensions，刷新朗读扩展并接受新增的本机程序通信权限。'
Write-Host '以后可直接点击扩展侧栏里的“启动本机服务”。'
