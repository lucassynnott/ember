param([Parameter(Mandatory=$true)][string]$InstallDirectory,[Parameter(Mandatory=$true)][string]$LocalProfile)
$ErrorActionPreference='Stop'
$install=[IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')+'\'
$local=[IO.Path]::GetFullPath($LocalProfile).TrimEnd('\')+'\'
$rows=@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and ($_.ExecutablePath.StartsWith($install,[StringComparison]::OrdinalIgnoreCase) -or $_.ExecutablePath.StartsWith($local,[StringComparison]::OrdinalIgnoreCase))} | ForEach-Object {
  $window=0;try {$window=(Get-Process -Id $_.ProcessId -ErrorAction Stop).MainWindowHandle.ToInt64()} catch {}
  [PSCustomObject]@{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;path=$_.ExecutablePath;command=$_.CommandLine;window=$window}
})
ConvertTo-Json -InputObject $rows -Compress -Depth 4
