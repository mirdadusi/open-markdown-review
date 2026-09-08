param([Parameter(Mandatory=$true)][int]$BrowserPid, [Parameter(Mandatory=$true)][string]$Folder)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:CI -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw 'Native picker automation is restricted to Windows CI.' }
if ($BrowserPid -le 0 -or $Folder -notmatch '^\\\\localhost\\omr_ci_[a-f0-9]{32}\\omr-permissions-[A-Za-z0-9]+\\review$') { throw 'Unexpected browser PID or disposable CI share path.' }
Get-Process -Id $BrowserPid -ErrorAction Stop | Out-Null
Get-Item -LiteralPath $Folder -ErrorAction Stop | Out-Null
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $BrowserPid)
$deadline = [DateTime]::UtcNow.AddSeconds(25)
$selected = $false
while ([DateTime]::UtcNow -lt $deadline) {
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
  foreach ($window in $windows) {
    $buttonCondition = New-Object System.Windows.Automation.AndCondition(
      (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)),
      (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Select Folder')))
    $button = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)
    if ($null -eq $button) { continue }
    # Use the real Windows folder dialog, not browser security flags or a mock handle.
    $button.SetFocus()
    [System.Windows.Forms.SendKeys]::SendWait('%d')
    [System.Windows.Forms.SendKeys]::SendWait($Folder)
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Start-Sleep -Milliseconds 400
    $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    $selected = $true
    break
  }
  if ($selected) { break }
  Start-Sleep -Milliseconds 200
}
if (-not $selected) { throw 'The actual Windows folder picker was unavailable. An interactive CI desktop and English dialog labels are required.' }
# Some Chromium releases show a separate file-edit permission confirmation.
$deadline = [DateTime]::UtcNow.AddSeconds(5)
while ([DateTime]::UtcNow -lt $deadline) {
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
  foreach ($window in $windows) {
    foreach ($label in @('Edit files', 'View files', 'Allow')) {
      $confirmation = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.AndCondition(
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)),
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $label)))))
      if ($null -ne $confirmation) { $confirmation.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); exit 0 }
    }
  }
  Start-Sleep -Milliseconds 200
}
