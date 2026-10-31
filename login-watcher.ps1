# Redirects the claude:// sign-in callback into a specific instance profile.
# Windows launches the callback as `Claude.exe "claude://..."` with no
# --user-data-dir, which would open the default (main) profile. We kill that
# process as soon as it appears and relaunch the same URL with the instance's
# --user-data-dir; Electron forwards it to the already-running instance.
param(
  [Parameter(Mandatory)] [string] $Exe,
  [Parameter(Mandatory)] [string] $Dir,
  [Parameter(Mandatory)] [string] $Log,
  [int] $TimeoutSec = 600
)

function Write-Log($m) { Add-Content -Path $Log -Value ("[{0}] watcher: {1}" -f (Get-Date).ToUniversalTime().ToString('o'), $m) }

Write-Log "start dir=$Dir"
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
  $procs = Get-CimInstance Win32_Process -Filter "Name='Claude.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'claude://' -and $_.CommandLine -notmatch '--user-data-dir' }
  foreach ($p in $procs) {
    if ($p.CommandLine -match '"(claude://[^"]+)"' -or $p.CommandLine -match '(claude://\S+)') {
      $url = $Matches[1]
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
      Write-Log "caught callback pid=$($p.ProcessId); rerouting"
      Start-Process -FilePath $Exe -ArgumentList @("--user-data-dir=`"$Dir`"", "`"$url`"")
      if ($url -match 'claude://login') { Write-Log "login rerouted; exiting"; exit 0 }
    }
  }
  Start-Sleep -Milliseconds 100
}
Write-Log "timeout"
