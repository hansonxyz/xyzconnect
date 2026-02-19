$ErrorActionPreference = "Stop"

$ShareRoot = Split-Path -Parent $PSScriptRoot
$Src = Join-Path $PSScriptRoot "dist\win-unpacked"
$Dst = "C:\xyzconnect"
$LogFile = Join-Path $ShareRoot "gui-debug.log"

Write-Host "Syncing XYZConnect to $Dst ..."
if (!(Test-Path $Dst)) { New-Item -ItemType Directory -Path $Dst | Out-Null }
robocopy $Src $Dst /MIR /NJH /NJS /NP /NFL /NDL | Out-Null

Write-Host "Starting XYZConnect (logging to $LogFile) ..."
& "$Dst\XYZConnect.exe" "--log-file=$LogFile"
