param([Parameter(Mandatory=$true)][int]$TargetPid,[Parameter(Mandatory=$true)][ValidateSet('save','cancel')][string]$Action,[string]$OutputFile)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
if($Action -eq 'save' -and (-not [IO.Path]::IsPathRooted($OutputFile) -or [IO.File]::Exists($OutputFile))) { throw 'The fixture export requires a new absolute output filename.' }
$owner=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$TargetPid)
$deadline=[DateTime]::UtcNow.AddSeconds(20)
$dialog=$null
do {
  $windows=[System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,$owner)
  $ownedDialogs=@($windows | Where-Object { $_.Current.ClassName -eq '#32770' })
  if($ownedDialogs.Count -gt 1) { throw 'The owned app has ambiguous native dialogs.' }
  if($ownedDialogs.Count -eq 1) { $dialog=$ownedDialogs[0]; break }
  Start-Sleep -Milliseconds 100
} while([DateTime]::UtcNow -lt $deadline)
if($null -eq $dialog) { throw 'The owned app did not open its native Save dialog.' }
if($dialog.Current.ProcessId -ne $TargetPid) { throw 'The Save dialog belongs to another process.' }

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class EmberSaveControls {
  [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent,IntPtr child);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint process);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,StringBuilder text,int size);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageTimeoutW")] public static extern IntPtr Text(IntPtr h,uint message,IntPtr w,string text,uint flags,uint timeout,out UIntPtr result);
  [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW")] public static extern IntPtr Click(IntPtr h,uint message,IntPtr w,IntPtr l,uint flags,uint timeout,out UIntPtr result);
  [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageTimeoutW")] public static extern IntPtr Read(IntPtr h,uint message,IntPtr w,StringBuilder text,uint flags,uint timeout,out UIntPtr result);
}
'@
$dialogHandle=[IntPtr]$dialog.Current.NativeWindowHandle
function Wait-OwnedControl([string]$Id,[string]$Class,$Scope=$dialog) {
  $readyDeadline=[DateTime]::UtcNow.AddSeconds(10)
  do {
    $controls=$Scope.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty,$Id))
    $found=@()
    foreach($control in $controls) {
      $handle=[IntPtr]$control.Current.NativeWindowHandle
      if($handle -eq [IntPtr]::Zero) { continue }
      [uint32]$controlProcess=0
      [void][EmberSaveControls]::GetWindowThreadProcessId($handle,[ref]$controlProcess)
      $className=[Text.StringBuilder]::new(256)
      [void][EmberSaveControls]::GetClassName($handle,$className,256)
      if($controlProcess -eq $TargetPid -and [EmberSaveControls]::IsChild($dialogHandle,$handle) -and $className.ToString() -eq $Class -and [EmberSaveControls]::IsWindowEnabled($handle)) { $found+= $handle }
    }
    if($found.Count -gt 1) { throw "Ambiguous owned native control $Id." }
    if($found.Count -eq 1) { return $found[0] }
    Start-Sleep -Milliseconds 100
  } while([DateTime]::UtcNow -lt $readyDeadline)
  throw "The owned dialog native control $Id ($Class) is unavailable."
}
$buttonId=if($Action -eq 'save'){'1'}else{'2'}
if($Action -eq 'save') {
  $hostControl=$dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty,'FileNameControlHost'))
  if($null -eq $hostControl) { throw 'The owned filename host is unavailable.' }
  $fileName=Wait-OwnedControl '1001' 'Edit' $hostControl
  [UIntPtr]$result=[UIntPtr]::Zero
  if([EmberSaveControls]::Text($fileName,12,[IntPtr]::Zero,$OutputFile,2,5000,[ref]$result) -eq [IntPtr]::Zero -or $result.ToUInt64() -eq 0) { throw 'The native filename entry failed.' }
  $text=[Text.StringBuilder]::new(32768)
  if([EmberSaveControls]::Read($fileName,13,[IntPtr]32768,$text,2,5000,[ref]$result) -eq [IntPtr]::Zero -or $text.ToString() -ne $OutputFile) { throw 'The native filename did not retain the selected path.' }
}
$button=Wait-OwnedControl $buttonId 'Button'
[void][EmberSaveControls]::SetForegroundWindow($dialogHandle)
[UIntPtr]$result=[UIntPtr]::Zero
if([EmberSaveControls]::Click($button,245,[IntPtr]::Zero,[IntPtr]::Zero,2,5000,[ref]$result) -eq [IntPtr]::Zero) { throw 'The owned native dialog action timed out.' }
@{nativeSaveDialog=$true;ownedProcess=$TargetPid;action=$Action}|ConvertTo-Json -Compress
