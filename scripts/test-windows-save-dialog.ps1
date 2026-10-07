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
# The native window appears before its UI Automation descendants finish loading.
function Wait-OwnedControl([string]$Id,[System.Windows.Automation.ControlType]$Type) {
  $readyDeadline=[DateTime]::UtcNow.AddSeconds(15)
  do {
    $control=$dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.AndCondition]::new(
      [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty,$Id),
      [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,$Type)))
    if($null -ne $control -and $control.Current.IsEnabled) { return $control }
    Start-Sleep -Milliseconds 100
  } while([DateTime]::UtcNow -lt $readyDeadline)
  $controls=$dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
  $details=@($controls | ForEach-Object { @{id=$_.Current.AutomationId;type=$_.Current.ControlType.ProgrammaticName;enabled=$_.Current.IsEnabled;name=$_.Current.Name} }) | ConvertTo-Json -Compress
  throw "The owned dialog control $Id is unavailable: $details"
}
$buttonId=if($Action -eq 'save'){'1'}else{'2'}
if($Action -eq 'save') {
  $fileName=Wait-OwnedControl '1001' ([System.Windows.Automation.ControlType]::Edit)
  $value=$fileName.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  $value.SetValue($OutputFile)
  if($value.Current.Value -ne $OutputFile) { throw 'The Save dialog did not retain the fixture filename.' }
}
$button=Wait-OwnedControl $buttonId ([System.Windows.Automation.ControlType]::Button)
$invoke=$button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
$invoke.Invoke()
@{nativeSaveDialog=$true;ownedProcess=$TargetPid;action=$Action}|ConvertTo-Json -Compress
