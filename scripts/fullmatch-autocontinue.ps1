[CmdletBinding()]
param(
  [switch]$Once,
  [switch]$Stop,
  [switch]$Status,
  [switch]$AcknowledgeNoOtherWriter
)
$ErrorActionPreference = 'Stop'
$taskRepo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runnerArgs = @((Join-Path $PSScriptRoot 'fullmatch/supervisor.js'), '--repo', $taskRepo)
if ($Once) { $runnerArgs += '--once' }
if ($Stop) { $runnerArgs += '--stop' }
if ($Status) { $runnerArgs += '--status' }
if ($AcknowledgeNoOtherWriter) { $runnerArgs += '--acknowledge-no-other-writer' }
& node @runnerArgs
exit $LASTEXITCODE
