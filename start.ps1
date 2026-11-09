# Compatible with Windows PowerShell 5.1. No scheduled task or startup entry.
$ErrorActionPreference = 'Stop'
$ServiceUrl = 'http://127.0.0.1:18765'
$PythonPath = Join-Path $PSScriptRoot '.venv\Scripts\pythonw.exe'
$ServerPath = Join-Path $PSScriptRoot 'server.py'

function Test-ReaderHealth {
    try {
        $Health = Invoke-RestMethod -Uri ($ServiceUrl + '/health') -Method Get -TimeoutSec 1
        return ($Health.ok -eq $true -and $Health.voice -eq 'zh-CN-XiaoxiaoNeural')
    }
    catch {
        return $false
    }
}

if (-not (Test-ReaderHealth)) {
    if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) {
        throw 'Missing .venv\Scripts\pythonw.exe. Create the virtual environment and install requirements first.'
    }
    if (-not (Test-Path -LiteralPath $ServerPath -PathType Leaf)) {
        throw 'Missing server.py next to start.ps1.'
    }
    $ServerProcess = Start-Process -FilePath $PythonPath -ArgumentList ('"' + $ServerPath + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
    $Timer = [System.Diagnostics.Stopwatch]::StartNew()
    $Ready = $false
    # Reserve one second for the final health request, keeping startup wait <= 8s.
    while ($Timer.Elapsed.TotalSeconds -lt 7) {
        if (Test-ReaderHealth) {
            $Ready = $true
            break
        }
        $ServerProcess.Refresh()
        if ($ServerProcess.HasExited) {
            throw 'Reader service exited. Run .venv\Scripts\python.exe server.py from this folder to inspect the error.'
        }
        if ($Timer.Elapsed.TotalSeconds -lt 6.85) { Start-Sleep -Milliseconds 150 }
    }
    $Timer.Stop()
    if (-not $Ready) {
        throw 'Reader service did not become healthy within 8 seconds. Check dependencies and port 18765.'
    }
}

Start-Process -FilePath ($ServiceUrl + '/')
