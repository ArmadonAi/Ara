# Ara Personal AI Control Plane - Windows Setup Script (PowerShell)
$ErrorActionPreference = "Stop"

Write-Host "=============================================================" -ForegroundColor Cyan
Write-Host "       Ara Personal AI Control Plane Installer (Windows)     " -ForegroundColor Cyan
Write-Host "=============================================================" -ForegroundColor Cyan
Write-Host "Initializing environment setup..."
Write-Host ""

# 1. Verify/Install Bun
$bunInstalled = $false
try {
    $version = bun --version
    Write-Host "[1/4] Bun runtime detected: v$($version.Trim())" -ForegroundColor Green
    $bunInstalled = $true
} catch {
    Write-Host "[1/4] Bun runtime not detected. Installing Bun..." -ForegroundColor Yellow
    powershell -c "irm bun.sh/install.ps1 | iex"
    
    # Reload Path environment variable
    $env:PATH = [System.Environment]::GetEnvironmentVariable("Path", "User") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    
    try {
        $version = bun --version
        Write-Host "✅ Bun successfully installed: v$($version.Trim())" -ForegroundColor Green
        $bunInstalled = $true
    } catch {
        Write-Host "❌ Error: Bun installation completed but 'bun' command remains unavailable. Please restart PowerShell and run again." -ForegroundColor Red
        Exit 1
    }
}
Write-Host ""

# 2. Install dependencies
Write-Host "[2/4] Installing monorepo workspace dependencies..." -ForegroundColor Cyan
bun install
Write-Host "✅ Dependencies successfully resolved and linked." -ForegroundColor Green
Write-Host ""

# 3. Copy environment variables
Write-Host "[3/4] Checking environment configurations..." -ForegroundColor Cyan
$envFile = Join-Path $PSScriptRoot ".env"
$envExample = Join-Path $PSScriptRoot ".env.example"

if (-not (Test-Path $envFile)) {
    if (Test-Path $envExample) {
        Copy-Item $envExample $envFile
        Write-Host "✅ Generated new local configuration: .env (copied from .env.example)" -ForegroundColor Green
        Write-Host "👉 Please edit .env to insert your target LLM provider API keys." -ForegroundColor Yellow
    } else {
        New-Item -Path $envFile -ItemType File | Out-Null
        Write-Host "✅ Created blank .env file." -ForegroundColor Green
    }
} else {
    Write-Host "✅ Existing local .env configuration detected." -ForegroundColor Green
}
Write-Host ""

# 4. Create local directories
Write-Host "[4/4] Creating local workspace directory structure..." -ForegroundColor Cyan
$dirs = @(
    (Join-Path $PSScriptRoot ".ara"),
    (Join-Path $PSScriptRoot ".ara\backups"),
    (Join-Path $PSScriptRoot ".ara\logs"),
    (Join-Path $PSScriptRoot ".ara\sessions"),
    (Join-Path $PSScriptRoot "memory")
)

foreach ($dir in $dirs) {
    if (-not (Test-Path $dir)) {
        New-Item -Path $dir -ItemType Directory | Out-Null
        $relPath = Resolve-Path $dir -Relative
        Write-Host "✅ Created directory: $relPath" -ForegroundColor Green
    }
}
Write-Host ""

Write-Host "=============================================================" -ForegroundColor Cyan
Write-Host "🎉 Setup Completed Successfully!" -ForegroundColor Green
Write-Host "=============================================================" -ForegroundColor Cyan
Write-Host "Ara Personal AI Control Plane is initialized and ready."
Write-Host ""
Write-Host "To start the web dashboard, Hono backend, and background worker concurrently:"
Write-Host "   bun run dev" -ForegroundColor Yellow
Write-Host ""
Write-Host "To start chatting via interactive console TUI:"
Write-Host "   bun link" -ForegroundColor Yellow
Write-Host "   ara tui" -ForegroundColor Yellow
Write-Host "=============================================================" -ForegroundColor Cyan
