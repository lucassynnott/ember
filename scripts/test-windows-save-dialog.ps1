param([Parameter(Mandatory=$true)][int]$TargetPid,[Parameter(Mandatory=$true)][ValidateSet('save','cancel')][string]$Action,[string]$OutputFile)
$ErrorActionPreference='Stop'
function Trace-Stage([string]$Stage) { [Console]::Error.WriteLine('EMBER_SAVE_STAGE '+$Stage+' '+[DateTime]::UtcNow.ToString('o')) }
Trace-Stage 'loading-native-driver'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
if($Action -eq 'save' -and (-not [IO.Path]::IsPathRooted($OutputFile) -or [IO.File]::Exists($OutputFile))) { throw 'The fixture export requires a new absolute output filename.' }
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class EmberSaveControls {
  public delegate bool WindowCallback(IntPtr h,IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumWindows(WindowCallback callback,IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent,WindowCallback callback,IntPtr parameter);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
  public static IntPtr[] OwnedButtons(IntPtr parent,int id,uint process) {
    var found=new List<IntPtr>();
    EnumChildWindows(parent,(h,p)=>{uint owner;GetWindowThreadProcessId(h,out owner);var name=new StringBuilder(256);GetClassName(h,name,256);if(owner==process&&IsChild(parent,h)&&name.ToString()=="Button"&&GetDlgCtrlID(h)==id&&IsWindowEnabled(h))found.Add(h);return true;},IntPtr.Zero);
    return found.ToArray();
  }
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder text,int size);
  public static IntPtr[] Dialogs(uint process) {
    var found=new List<IntPtr>();
    EnumWindows((h,p)=>{uint owner;GetWindowThreadProcessId(h,out owner);var name=new StringBuilder(256);GetClassName(h,name,256);if(owner==process&&name.ToString()=="#32770"&&IsWindowVisible(h))found.Add(h);return true;},IntPtr.Zero);
    return found.ToArray();
  }
  public static string Windows(uint process) {
    var found=new List<string>();
    EnumWindows((h,p)=>{uint owner;GetWindowThreadProcessId(h,out owner);if(owner==process){var name=new StringBuilder(256);var title=new StringBuilder(512);GetClassName(h,name,256);GetWindowText(h,title,512);found.Add("handle="+h+", class="+name+", visible="+IsWindowVisible(h)+", title="+title);}return true;},IntPtr.Zero);
    return String.Join("; ",found);
  }
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

$deadline=[DateTime]::UtcNow.AddSeconds(20)
Trace-Stage 'native-driver-ready'
$dialogHandle=[IntPtr]::Zero
do {
  $ownedDialogs=@([EmberSaveControls]::Dialogs([uint32]$TargetPid))
  if($ownedDialogs.Count -gt 1) { throw 'The owned app has ambiguous visible native dialogs.' }
  if($ownedDialogs.Count -eq 1) { $dialogHandle=$ownedDialogs[0]; break }
  Start-Sleep -Milliseconds 100
} while([DateTime]::UtcNow -lt $deadline)
if($dialogHandle -eq [IntPtr]::Zero) { throw ("The owned app did not open a visible native Save dialog. " + [EmberSaveControls]::Windows([uint32]$TargetPid)) }
Trace-Stage 'owned-native-dialog-found'
[uint32]$dialogProcess=0
[void][EmberSaveControls]::GetWindowThreadProcessId($dialogHandle,[ref]$dialogProcess)
if($dialogProcess -ne $TargetPid) { throw 'The native Save dialog belongs to another process.' }
if($Action -eq 'cancel') {
  $cancelDeadline=[DateTime]::UtcNow.AddSeconds(10)
  do {
    $buttons=@([EmberSaveControls]::OwnedButtons($dialogHandle,2,[uint32]$TargetPid))
    if($buttons.Count -gt 1) { throw 'The owned native Cancel button is ambiguous.' }
    if($buttons.Count -eq 1) { break }
    Start-Sleep -Milliseconds 100
  } while([DateTime]::UtcNow -lt $cancelDeadline)
  if($buttons.Count -ne 1) { throw 'The owned native Cancel button is unavailable.' }
  Trace-Stage 'owned-native-cancel-ready'
  [void][EmberSaveControls]::SetForegroundWindow($dialogHandle)
  [UIntPtr]$result=[UIntPtr]::Zero
  if([EmberSaveControls]::Click($buttons[0],245,[IntPtr]::Zero,[IntPtr]::Zero,2,5000,[ref]$result) -eq [IntPtr]::Zero) { throw 'The owned native cancellation timed out.' }
  Trace-Stage 'owned-native-cancel-clicked'
  @{nativeSaveDialog=$true;ownedProcess=$TargetPid;action=$Action;nativeCancelControl=$true}|ConvertTo-Json -Compress
  exit
}
Trace-Stage 'loading-filename-accessibility'
$dialog=[System.Windows.Automation.AutomationElement]::FromHandle($dialogHandle)
if($dialog.Current.ProcessId -ne $TargetPid) { throw 'The Save dialog belongs to another process.' }
$dialogHandle=[IntPtr]$dialog.Current.NativeWindowHandle
Trace-Stage 'filename-accessibility-ready'
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
  Trace-Stage 'owned-filename-control-ready'
  [UIntPtr]$result=[UIntPtr]::Zero
  # Editing the selection sends the edit-change notifications used by the shell.
  if([EmberSaveControls]::Click($fileName,177,[IntPtr]::Zero,[IntPtr](-1),2,5000,[ref]$result) -eq [IntPtr]::Zero) { throw 'Selecting the native filename failed.' }
  if([EmberSaveControls]::Text($fileName,194,[IntPtr]1,$OutputFile,2,5000,[ref]$result) -eq [IntPtr]::Zero) { throw 'The native filename entry failed.' }
  $text=[Text.StringBuilder]::new(32768)
  if([EmberSaveControls]::Read($fileName,13,[IntPtr]32768,$text,2,5000,[ref]$result) -eq [IntPtr]::Zero -or $text.ToString() -ne $OutputFile) { throw 'The native filename did not retain the selected path.' }
}
Trace-Stage 'selected-filename-verified'
$button=Wait-OwnedControl $buttonId 'Button'
Trace-Stage 'owned-save-button-ready'
[void][EmberSaveControls]::SetForegroundWindow($dialogHandle)
[UIntPtr]$result=[UIntPtr]::Zero
if([EmberSaveControls]::Click($button,245,[IntPtr]::Zero,[IntPtr]::Zero,2,5000,[ref]$result) -eq [IntPtr]::Zero) { throw 'The owned native dialog action timed out.' }
@{nativeSaveDialog=$true;ownedProcess=$TargetPid;action=$Action}|ConvertTo-Json -Compress
