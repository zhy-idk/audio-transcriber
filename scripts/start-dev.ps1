$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$serverProcess = $null
$frontendProcess = $null

function Stop-ProcessTree {
  param([System.Diagnostics.Process]$Process)

  if ($null -ne $Process -and -not $Process.HasExited) {
    & taskkill.exe /PID $Process.Id /T /F *> $null
  }
}

try {
  Write-Host 'Starting transcription backend...'
  $serverProcess = Start-Process `
    -FilePath 'npm.cmd' `
    -ArgumentList @('run', 'dev:server') `
    -WorkingDirectory $projectRoot `
    -NoNewWindow `
    -PassThru

  Start-Sleep -Seconds 1

  Write-Host 'Starting Vite frontend...'
  $frontendProcess = Start-Process `
    -FilePath 'npm.cmd' `
    -ArgumentList @('run', 'dev') `
    -WorkingDirectory $projectRoot `
    -NoNewWindow `
    -PassThru

  Write-Host ''
  Write-Host 'Frontend and backend are running. Press Ctrl+C to stop both.'
  Write-Host 'Frontend: http://127.0.0.1:5173'
  Write-Host 'Backend:  http://127.0.0.1:3001'

  while ($true) {
    if ($serverProcess.HasExited) {
      throw "The backend exited with code $($serverProcess.ExitCode)."
    }
    if ($frontendProcess.HasExited) {
      throw "The frontend exited with code $($frontendProcess.ExitCode)."
    }
    Start-Sleep -Milliseconds 500
  }
}
catch {
  Write-Error $_
  exit 1
}
finally {
  Stop-ProcessTree $frontendProcess
  Stop-ProcessTree $serverProcess
}
