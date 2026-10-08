# Updates the stack to the images in .env: pulls them, stops web and worker, backs up the database
# to backups\, runs the migrations, then starts everything. If the migrations fail, web and worker
# stay stopped and the restore commands are printed. Same as update.sh, for Windows PowerShell:
#   powershell -ExecutionPolicy Bypass -File .\update.ps1
# Not 'Stop': docker writes its progress to stderr. Each step checks the exit code instead.
$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath $PSScriptRoot

function Invoke-Step([string]$what, [scriptblock]$command) {
  & $command
  if ($LASTEXITCODE -ne 0) { throw "$what failed (exit code $LASTEXITCODE)." }
}

if (-not (Test-Path .env)) { throw 'No .env next to docker-compose.yml: copy .env.example first.' }

$backup = "backups\agile-$(Get-Date -Format yyyyMMdd-HHmmss).dump"
New-Item -ItemType Directory -Force backups | Out-Null

Write-Host '==> Pulling the images'
Invoke-Step 'docker compose pull' { docker compose pull }

Write-Host '==> Stopping web and worker'
Invoke-Step 'Stopping web and worker' { docker compose stop web worker }

Write-Host "==> Backing up the database to deploy\compose\$backup"
Invoke-Step 'Starting postgres' { docker compose up -d --wait postgres }
# Through cmd: PowerShell's own > would re-encode the binary dump as text.
Invoke-Step 'pg_dump' { cmd /c "docker compose exec -T postgres pg_dump -U agile -d agile -Fc > $backup" }
if ((Get-Item $backup).Length -eq 0) { throw 'The backup is empty: stopping here (nothing was migrated).' }

Write-Host '==> Running the migrations'
$attempt = 1
while ($true) {
  docker compose run --rm --no-deps migrate
  if ($LASTEXITCODE -eq 0) { break }
  if ($attempt -ge 3) {
    Write-Host @"

The migrations failed (3 attempts). web and worker are stopped. To go back to the backup, in
$($PSScriptRoot):
  1. In .env, set WEB_IMAGE, WORKER_IMAGE and MIGRATE_IMAGE back to the previous release.
  2. docker compose exec -T postgres dropdb -U agile --force agile
     cmd /c "docker compose exec -T postgres pg_restore -U agile -d postgres --create --exit-on-error < $backup"
  3. docker compose up -d
"@ -ForegroundColor Red
    exit 1
  }
  $attempt++
  Write-Host "Migrations failed, retrying in 5 s (attempt $attempt of 3)"
  Start-Sleep -Seconds 5
}

Write-Host '==> Starting the stack'
Invoke-Step 'docker compose up' { docker compose up -d }
docker compose ps
Write-Host "Done. Backup: deploy\compose\$backup"
