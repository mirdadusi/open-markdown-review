$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# CI-owned loopback SMB exercises the real Windows SMB redirector without using
# any employee or production share. Require privileges; never silently skip it.
if ($env:CI -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw 'This qualification script runs only in Windows CI.' }
if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) { throw 'RUNNER_TEMP is required.' }
$temporaryRoot = (Get-Item -LiteralPath $env:RUNNER_TEMP -ErrorAction Stop).FullName
if (-not (Test-Path -LiteralPath $temporaryRoot -PathType Container)) { throw 'Runner temporary directory is unavailable.' }
$shareName = 'omr_ci_' + [guid]::NewGuid().ToString('N')
$fixturePath = Join-Path $temporaryRoot $shareName
if (Test-Path -LiteralPath $fixturePath) { throw 'Unexpected existing fixture directory.' }
$fixture = New-Item -ItemType Directory -Path $fixturePath -ErrorAction Stop
if ($fixture.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Fixture directory is a reparse point.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
if ([string]::IsNullOrWhiteSpace($identity)) { throw 'Cannot resolve the CI account.' }
$created = $false
try {
  New-SmbShare -Name $shareName -Path $fixture.FullName -FullAccess $identity -ErrorAction Stop | Out-Null
  $created = $true
  $share = Get-SmbShare -Name $shareName -ErrorAction Stop
  if ($share.Path -ne $fixture.FullName) { throw 'SMB fixture path mismatch.' }
  $env:OMR_TEST_REVIEW_ROOT = '\\localhost\' + $shareName
  Get-Item -LiteralPath $env:OMR_TEST_REVIEW_ROOT -ErrorAction Stop | Out-Null
  Write-Host "Qualifying disposable SMB fixture: $($env:OMR_TEST_REVIEW_ROOT)"
  node --test out/test/share.integration.js out/test/browser.integration.js
  if ($LASTEXITCODE -ne 0) { throw "SMB qualification failed with exit code $LASTEXITCODE" }
  node --test out/test/windows.browser.integration.js
  if ($LASTEXITCODE -ne 0) { throw "Real Windows browser folder-grant qualification failed with exit code $LASTEXITCODE" }
} finally {
  $env:OMR_TEST_REVIEW_ROOT = $null
  if ($created) {
    $ownedShare = Get-SmbShare -Name $shareName -ErrorAction Stop
    if ($ownedShare.Name -ne $shareName -or $ownedShare.Path -ne $fixture.FullName) { throw 'Refusing cleanup of an unexpected SMB share.' }
    Remove-SmbShare -Name $shareName -Force -Confirm:$false -ErrorAction Stop
    Write-Host 'Removed only the CI-created SMB share mapping. Fixture files remain in runner temporary storage.'
  }
}
