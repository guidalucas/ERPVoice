[CmdletBinding()]
param(
  [switch]$Once,
  [switch]$Stop,
  [switch]$Status,
  [switch]$AcknowledgeNoOtherWriter,
  [string]$CodexPath,
  [string]$NodePath
)
$ErrorActionPreference = 'Stop'
$taskRepo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runnerArgs = @((Join-Path $PSScriptRoot 'fullmatch/supervisor.js'), '--repo', $taskRepo)
if ($Once) { $runnerArgs += '--once' }
if ($Stop) { $runnerArgs += '--stop' }
if ($Status) { $runnerArgs += '--status' }
if ($AcknowledgeNoOtherWriter) { $runnerArgs += '--acknowledge-no-other-writer' }
if (-not $NodePath) {
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($nodeCommand) { $NodePath = $nodeCommand.Source }
  else { $NodePath = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
}
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'Node.js no encontrado. Instale Node.js o indique -NodePath con la ruta a node.exe.' }
if (-not $Status -and -not $Stop) {
  if (-not $CodexPath) {
    $codexCommand = Get-Command codex.exe -ErrorAction SilentlyContinue
    if ($codexCommand) { $CodexPath = $codexCommand.Source }
    else {
      $codexDirectory = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
      $codexCandidate = Get-ChildItem -Path (Join-Path $codexDirectory '*\codex.exe') -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
      if ($codexCandidate) { $CodexPath = $codexCandidate.FullName }
    }
  }
  if (-not $CodexPath -or -not (Test-Path -LiteralPath $CodexPath -PathType Leaf)) { throw 'Codex CLI no encontrado. Indique -CodexPath con la ruta a codex.exe.' }
  $runnerArgs += @('--codex', $CodexPath)
}
& $NodePath @runnerArgs
exit $LASTEXITCODE
