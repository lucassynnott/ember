param([Parameter(Mandatory=$true)][int]$TargetPid)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;using System.Text;using System.Runtime.InteropServices;
public static class EmberUpdateWizard {
 public delegate bool EnumProc(IntPtr window,IntPtr argument);
 [DllImport("user32.dll")]public static extern bool EnumWindows(EnumProc callback,IntPtr argument);
 [DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
 [DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr window);
 [DllImport("user32.dll")]public static extern bool IsWindowEnabled(IntPtr window);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetClassName(IntPtr window,StringBuilder name,int length);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetWindowText(IntPtr window,StringBuilder text,int length);
 [DllImport("user32.dll")]public static extern IntPtr GetDlgItem(IntPtr window,int id);
 [DllImport("user32.dll")]public static extern bool IsChild(IntPtr parent,IntPtr child);
 [DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr window);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr SendMessageTimeout(IntPtr window,uint message,IntPtr wparam,IntPtr lparam,uint flags,uint timeout,out IntPtr result);
}
'@
$dialogs=[Collections.Generic.List[IntPtr]]::new()
$callback=[EmberUpdateWizard+EnumProc]{param($window,$argument);[uint32]$owner=0;[void][EmberUpdateWizard]::GetWindowThreadProcessId($window,[ref]$owner);if($owner -eq $TargetPid -and [EmberUpdateWizard]::IsWindowVisible($window)){$class=[Text.StringBuilder]::new(128);[void][EmberUpdateWizard]::GetClassName($window,$class,$class.Capacity);if($class.ToString() -eq '#32770'){$dialogs.Add($window)}};return $true}
[void][EmberUpdateWizard]::EnumWindows($callback,[IntPtr]::Zero)
if($dialogs.Count -gt 1){throw 'Ambiguous owned installer wizard'}
if($dialogs.Count -eq 0){ConvertTo-Json -Compress @{ownedProcess=$TargetPid;action='waiting'};exit 0}
$window=$dialogs[0];$button=[EmberUpdateWizard]::GetDlgItem($window,1)
if($button -eq [IntPtr]::Zero -or ![EmberUpdateWizard]::IsWindowEnabled($button)){ConvertTo-Json -Compress @{ownedProcess=$TargetPid;action='waiting'};exit 0}
[uint32]$owner=0;[void][EmberUpdateWizard]::GetWindowThreadProcessId($button,[ref]$owner)
if($owner -ne $TargetPid -or ![EmberUpdateWizard]::IsChild($window,$button)){throw 'Installer action control ownership mismatch'}
$text=[Text.StringBuilder]::new(128);[void][EmberUpdateWizard]::GetWindowText($button,$text,$text.Capacity);$caption=$text.ToString().Replace('&','').Trim()
if($caption -notmatch '^(Next\s*>?|Install|Finish)$'){throw "Unexpected installer action: $caption"}
[void][EmberUpdateWizard]::SetForegroundWindow($window);[IntPtr]$result=[IntPtr]::Zero
$sent=[EmberUpdateWizard]::SendMessageTimeout($button,245,[IntPtr]::Zero,[IntPtr]::Zero,2,5000,[ref]$result)
ConvertTo-Json -Compress @{ownedProcess=$TargetPid;action='clicked';caption=$caption;responded=($sent -ne [IntPtr]::Zero)}
