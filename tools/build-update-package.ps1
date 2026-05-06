<#
.SYNOPSIS
    Builds the AI-on-the-edge-device firmware with Docker and packages it
    for OTA deployment to a running device.

.DESCRIPTION
    Runs a three-stage Docker build (builder → webui → artifacts), extracts
    the resulting files, and produces:
      - artifacts/          raw build outputs
      - ai-edge-update.zip  ready-to-upload OTA package

    The zip can be uploaded directly via the device's OTA page at
    http://<device-ip>/ota

.PARAMETER Tag
    Docker image tag to use.  Default: ai-edge-build

.PARAMETER OutDir
    Directory where artifacts/ and the zip are placed.
    Default: <repo-root>/build-output

.PARAMETER FirmwareOnly
    Skip repacking html/demo/config into the zip.
    The zip will contain only firmware.bin (fastest update when only code changed).

.EXAMPLE
    # Full build + package from repo root:
    .\tools\build-update-package.ps1

.EXAMPLE
    # Firmware-only zip, custom output dir:
    .\tools\build-update-package.ps1 -FirmwareOnly -OutDir C:\temp\ai-edge
#>
[CmdletBinding()]
param(
    [string] $Tag          = "ai-edge-build",
    [string] $OutDir       = "",
    [switch] $FirmwareOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Resolve paths
# ---------------------------------------------------------------------------
$RepoRoot = (Resolve-Path "$PSScriptRoot\..").Path

if (-not $OutDir) {
    $OutDir = Join-Path $RepoRoot "build-output"
}

$ArtifactsDir    = Join-Path $OutDir "artifacts"
$ZipPath         = Join-Path $OutDir "ai-edge-update.zip"
$ZipPathWithCfg  = Join-Path $OutDir "ai-edge-update-with-config.zip"
$StagingDir      = Join-Path $OutDir "_staging"
$TmpContainer = "ai-edge-tmp-$([System.Guid]::NewGuid().ToString('N').Substring(0,8))"

Write-Host ""
Write-Host "=== AI-on-the-edge-device build + package ===" -ForegroundColor Cyan
Write-Host "  Repo:       $RepoRoot"
Write-Host "  Output:     $OutDir"
Write-Host "  Docker tag: $Tag"
Write-Host "  Mode:       $(if ($FirmwareOnly) { 'firmware-only' } else { 'full' })"
Write-Host ""

# ---------------------------------------------------------------------------
# Step 1 — Docker build
# ---------------------------------------------------------------------------
Write-Host "[1/4] Building Docker image (target: artifacts)..." -ForegroundColor Yellow

Push-Location $RepoRoot
try {
    docker build --target artifacts -t $Tag .
    if ($LASTEXITCODE -ne 0) { throw "docker build failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

# ---------------------------------------------------------------------------
# Step 2 — Extract artifacts from image
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "[2/4] Extracting artifacts from image..." -ForegroundColor Yellow

if (Test-Path $ArtifactsDir) {
    Remove-Item -Recurse -Force $ArtifactsDir
}
New-Item -ItemType Directory -Force -Path $ArtifactsDir | Out-Null

try {
    docker create --name $TmpContainer $Tag | Out-Null
    docker cp "${TmpContainer}:/artifacts/." $ArtifactsDir
    if ($LASTEXITCODE -ne 0) { throw "docker cp failed (exit $LASTEXITCODE)" }
} finally {
    docker rm $TmpContainer 2>$null | Out-Null
}

Write-Host "  Artifacts written to: $ArtifactsDir"

# ---------------------------------------------------------------------------
# Step 3 — Stage files for the zip
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "[3/4] Staging OTA package..." -ForegroundColor Yellow

if (Test-Path $StagingDir) {
    Remove-Item -Recurse -Force $StagingDir
}
New-Item -ItemType Directory -Force -Path $StagingDir | Out-Null

# firmware.bin is always included
Copy-Item (Join-Path $ArtifactsDir "firmware.bin") (Join-Path $StagingDir "firmware.bin")

if (-not $FirmwareOnly) {
    # Web UI (gzip-compressed html/css/js/...)
    $htmlSrc = Join-Path $ArtifactsDir "html"
    if (Test-Path $htmlSrc) {
        Copy-Item -Recurse $htmlSrc (Join-Path $StagingDir "html")
    } else {
        Write-Warning "  html/ not found in artifacts — skipping"
    }

    # Demo mode files
    $demoSrc = Join-Path $ArtifactsDir "demo"
    if (Test-Path $demoSrc) {
        Copy-Item -Recurse $demoSrc (Join-Path $StagingDir "demo")
    } else {
        Write-Warning "  demo/ not found in artifacts — skipping"
    }

    # TFLite CNN models only. Whitelist *.tflite so an OTA update never
    # clobbers user-specific files in /sdcard/config/ — config.ini, prevalue.ini,
    # and the per-meter alignment markers ref0.jpg / ref0_org.jpg / ref1.jpg /
    # ref1_org.jpg / reference.jpg are calibrated to the user's installation.
    $configSrc = Join-Path $ArtifactsDir "config"
    if (Test-Path $configSrc) {
        $configDst = Join-Path $StagingDir "config"
        New-Item -ItemType Directory -Force -Path $configDst | Out-Null
        Get-ChildItem $configSrc -File -Filter "*.tflite" | ForEach-Object {
            Copy-Item $_.FullName (Join-Path $configDst $_.Name)
        }
    } else {
        Write-Warning "  config/ not found in artifacts — skipping"
    }
}

# ---------------------------------------------------------------------------
# Step 4 — Create the zip archives
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "[4/4] Creating OTA zips..." -ForegroundColor Yellow

if (Test-Path $ZipPath) { Remove-Item -Force $ZipPath }
if (Test-Path $ZipPathWithCfg) { Remove-Item -Force $ZipPathWithCfg }

# --- Archive WITHOUT config (for OTA updates preserving user config) ---
Compress-Archive -Path (Join-Path $StagingDir "*") -DestinationPath $ZipPath

# --- Archive WITH config folder (for fresh installs / full reset) ---
if (-not $FirmwareOnly) {
    $configSrc = Join-Path $ArtifactsDir "config"
    if (Test-Path $configSrc) {
        $configDst = Join-Path $StagingDir "config"
        if (-not (Test-Path $configDst)) {
            New-Item -ItemType Directory -Force -Path $configDst | Out-Null
        }
        # Copy ALL config files including config.ini and prevalue.ini
        Get-ChildItem $configSrc -File | ForEach-Object {
            Copy-Item $_.FullName (Join-Path $configDst $_.Name) -Force
        }
    }
}
Compress-Archive -Path (Join-Path $StagingDir "*") -DestinationPath $ZipPathWithCfg

Remove-Item -Recurse -Force $StagingDir

$ZipSize = [math]::Round((Get-Item $ZipPath).Length / 1MB, 1)
$ZipSizeWithCfg = [math]::Round((Get-Item $ZipPathWithCfg).Length / 1MB, 1)
Write-Host "  Created: $ZipPath ($ZipSize MB) — update only, preserves user config"
Write-Host "  Created: $ZipPathWithCfg ($ZipSizeWithCfg MB) — includes config/ for fresh install"

if ($ZipSize -gt 8) {
    Write-Warning "  Update zip is larger than 8 MB — the device OTA page may reject it."
    Write-Warning "  Consider using -FirmwareOnly and uploading html/ separately."
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Green
Write-Host ""
Write-Host "Artifacts:"
Get-ChildItem $ArtifactsDir | ForEach-Object {
    $size = if ($_.PSIsContainer) {
        "$((Get-ChildItem $_.FullName -Recurse -File | Measure-Object Length -Sum).Sum / 1KB -as [int]) KB"
    } else {
        "$([math]::Round($_.Length / 1KB, 1)) KB"
    }
    Write-Host "  $($_.Name.PadRight(20)) $size"
}
Write-Host ""
Write-Host "OTA packages:"
Write-Host "  $ZipPath" -ForegroundColor Cyan
Write-Host "    -> For updates (preserves device config)"
Write-Host "  $ZipPathWithCfg" -ForegroundColor Cyan
Write-Host "    -> For fresh installs (includes config/)"
Write-Host ""
Write-Host "To flash, open your device's OTA page and upload the zip:"
Write-Host "  http://<device-ip>/ota" -ForegroundColor Cyan
Write-Host ""
