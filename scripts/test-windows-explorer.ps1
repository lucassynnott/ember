param([Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][string]$Screenshot)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Explorer acceptance requires an isolated GitHub Windows runner.' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$Root = [IO.Path]::GetFullPath($Root).TrimEnd('\')
if (!(Test-Path -LiteralPath $Root -PathType Container)) { throw 'The owned Drive root is missing.' }
$shell = New-Object -ComObject Shell.Application
$before = @($shell.Windows() | ForEach-Object { [long]$_.HWND })
$owned = $null
function MatchesPath($window, [string]$expected) {
  try { return [IO.Path]::GetFullPath($window.Document.Folder.Self.Path).TrimEnd('\') -ieq $expected } catch { return $false }
}
try {
  $shell.Explore($Root)
  $deadline = [DateTime]::UtcNow.AddSeconds(25)
  while (!$owned) {
    foreach ($candidate in @($shell.Windows())) {
      if ($before -notcontains [long]$candidate.HWND -and (MatchesPath $candidate $Root)) { $owned = $candidate; break }
    }
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Explorer did not create a new window for the owned root.' }
    if (!$owned) { Start-Sleep -Milliseconds 200 }
  }
  $handle = [long]$owned.HWND
  $parent = [IO.Path]::GetDirectoryName($Root)
  $owned.Navigate2($parent)
  while (!(MatchesPath $owned $parent)) {
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Explorer did not navigate away from the Drive root.' }
    Start-Sleep -Milliseconds 100
  }
  $window = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new($handle))
  $treeCondition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TreeItem)
  $deadline = [DateTime]::UtcNow.AddSeconds(25)
  $selected = $false
  while (!$selected) {
    $items = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $treeCondition)
    if ($items.Count -gt 5000) { throw 'Explorer navigation exceeds the acceptance bound.' }
    foreach ($item in $items) {
      if ($item.Current.Name -ne 'Ember Drive') { continue }
      $pattern = $null
      if ($item.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
        $pattern.Select()
        $selected = $true
        break
      }
    }
    if ([DateTime]::UtcNow -ge $deadline) { throw 'The Ember Drive navigation item was not selectable.' }
    if (!$selected) { Start-Sleep -Milliseconds 200 }
  }
  while (!(MatchesPath $owned $Root)) {
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Selecting Ember Drive did not navigate to the registered root.' }
    Start-Sleep -Milliseconds 100
  }
  $window.SetFocus()
  $rect = $window.Current.BoundingRectangle
  $bounds = [Drawing.Rectangle]::new([int]$rect.X,[int]$rect.Y,[int]$rect.Width,[int]$rect.Height)
  $bounds = [Drawing.Rectangle]::Intersect($bounds,[System.Windows.Forms.SystemInformation]::VirtualScreen)
  if ($bounds.Width -lt 100 -or $bounds.Height -lt 100) { throw 'Explorer did not expose a visible window.' }
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Screenshot)) | Out-Null
  $bitmap = [Drawing.Bitmap]::new($bounds.Width,$bounds.Height)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try { $graphics.CopyFromScreen($bounds.Location,[Drawing.Point]::Empty,$bounds.Size); $bitmap.Save($Screenshot,[Drawing.Imaging.ImageFormat]::Png) }
  finally { $graphics.Dispose(); $bitmap.Dispose() }
  Write-Output ('EMBER_EXPLORER_TEST:' + (@{sidebarSelected=$true;registeredRootReached=$true;visibleWindow=$true;screenshotSaved=$true} | ConvertTo-Json -Compress))
} catch {
  $failure = $_
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Screenshot)) | Out-Null
  if ($window) {
    $elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $rows = @()
    for ($index=0; $index -lt [Math]::Min($elements.Count,5000); $index++) {
      try { $current=$elements[$index].Current; $rows += @{name=$current.Name;type=$current.ControlType.ProgrammaticName;offscreen=$current.IsOffscreen;automationId=$current.AutomationId} } catch {}
    }
    $rows | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath ([IO.Path]::ChangeExtension($Screenshot,'tree.json')) -Encoding UTF8
    try {
      $rect=$window.Current.BoundingRectangle
      $bounds=[Drawing.Rectangle]::Intersect([Drawing.Rectangle]::new([int]$rect.X,[int]$rect.Y,[int]$rect.Width,[int]$rect.Height),[System.Windows.Forms.SystemInformation]::VirtualScreen)
      if ($bounds.Width -ge 100 -and $bounds.Height -ge 100) {
        $bitmap=[Drawing.Bitmap]::new($bounds.Width,$bounds.Height); $graphics=[Drawing.Graphics]::FromImage($bitmap)
        try { $graphics.CopyFromScreen($bounds.Location,[Drawing.Point]::Empty,$bounds.Size); $bitmap.Save($Screenshot,[Drawing.Imaging.ImageFormat]::Png) } finally { $graphics.Dispose(); $bitmap.Dispose() }
      }
    } catch {}
  }
  throw $failure
} finally {
  # Close only the new window obtained for this exclusive test root.
  if ($owned -and $before -notcontains [long]$owned.HWND) { $owned.Quit() }
}
