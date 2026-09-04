<#
.SYNOPSIS
  Bumps manifest.json's version and zips the extension for Chrome Web Store upload.

.DESCRIPTION
  Replaces the manual "edit manifest.json, then hand-pick files into a zip"
  workflow. Only touches the "version" field in manifest.json (via a targeted
  string replace, not a JSON round-trip) so the rest of the file's formatting
  is untouched. Uploading the resulting zip to the Chrome Web Store dashboard
  is still a manual, deliberate step — this script doesn't publish anything.

.PARAMETER Bump
  Which part of the semver version to increment: patch (default), minor, or major.
  Ignored if -Version is passed.

.PARAMETER Version
  Set an explicit version (e.g. "1.0.0") instead of bumping.

.PARAMETER SkipBump
  Package the current manifest.json version as-is, without changing it.

.PARAMETER DryRun
  Print what would happen without writing manifest.json or creating a zip.

.EXAMPLE
  scripts\package-extension.ps1
  Bumps the patch version and creates releases\webhaste-v0.3.1.zip

.EXAMPLE
  scripts\package-extension.ps1 -Bump minor

.EXAMPLE
  scripts\package-extension.ps1 -Version 1.0.0

.EXAMPLE
  scripts\package-extension.ps1 -SkipBump
#>
param(
    [ValidateSet("patch", "minor", "major")]
    [string]$Bump = "patch",

    [string]$Version,

    [switch]$SkipBump,

    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repoRoot "manifest.json"
$releasesDir = Join-Path $repoRoot "releases"

# Everything the extension actually references at runtime (see CLAUDE.md's
# "How the pieces fit" for why templates/ and cli/compose.js are included —
# both get fetched via chrome.runtime.getURL() to scaffold user projects).
$includePaths = @(
    "manifest.json",
    "background.js",
    "compose-core.js",
    "editor.css",
    "editor.html",
    "editor.js",
    "preview-guard.js",
    "preview-window.js",
    "icons",
    "templates",
    "vendor",
    "cli"
)

$manifestText = Get-Content -Path $manifestPath -Raw
$versionPattern = '"version"\s*:\s*"(\d+)\.(\d+)\.(\d+)"'
$match = [regex]::Match($manifestText, $versionPattern)
if (-not $match.Success) {
    throw "Could not find a `"version`": `"x.y.z`" field in $manifestPath"
}
$currentVersion = "$($match.Groups[1].Value).$($match.Groups[2].Value).$($match.Groups[3].Value)"

if ($Version) {
    if ($Version -notmatch '^\d+\.\d+\.\d+$') {
        throw "-Version must look like x.y.z (got '$Version')"
    }
    $newVersion = $Version
}
elseif ($SkipBump) {
    $newVersion = $currentVersion
}
else {
    $major = [int]$match.Groups[1].Value
    $minor = [int]$match.Groups[2].Value
    $patch = [int]$match.Groups[3].Value
    switch ($Bump) {
        "major" { $major++; $minor = 0; $patch = 0 }
        "minor" { $minor++; $patch = 0 }
        "patch" { $patch++ }
    }
    $newVersion = "$major.$minor.$patch"
}

Write-Host "Current version: $currentVersion"
Write-Host "New version:     $newVersion"

if ($DryRun) {
    Write-Host "(dry run - manifest.json and releases\ left untouched)"
    exit 0
}

if ($newVersion -ne $currentVersion) {
    $updatedManifest = [regex]::Replace(
        $manifestText,
        $versionPattern,
        "`"version`": `"$newVersion`"",
        1
    )
    # Write-Content's "utf8" encoding adds a BOM on Windows PowerShell 5.1;
    # manifest.json has none, so write it back the same way it was read.
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($manifestPath, $updatedManifest, $utf8NoBom)
    Write-Host "Updated manifest.json"
}

if (-not (Test-Path $releasesDir)) {
    New-Item -ItemType Directory -Path $releasesDir | Out-Null
}

$zipName = "webhaste-v$newVersion.zip"
$zipPath = Join-Path $releasesDir $zipName
if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
}

# Compress-Archive stores literal backslash path separators in zip entry
# names on Windows, which violates the zip spec and breaks Chrome's ability
# to resolve manifest-relative paths like "icons/icon16.png" once unpacked.
# Build the archive by hand via System.IO.Compression instead, so every
# entry name uses forward slashes regardless of host OS.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$archive = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($relativePath in $includePaths) {
        $fullPath = Join-Path $repoRoot $relativePath
        if (Test-Path $fullPath -PathType Container) {
            $files = Get-ChildItem -Path $fullPath -Recurse -File
            foreach ($file in $files) {
                $entryName = $file.FullName.Substring($repoRoot.Length + 1) -replace '\\', '/'
                [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                    $archive, $file.FullName, $entryName,
                    [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
            }
        }
        else {
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive, $fullPath, $relativePath,
                [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    }
}
finally {
    $archive.Dispose()
}

Write-Host "Created $zipPath"
Write-Host ""
Write-Host "Next: upload this zip as a new package version at"
Write-Host "https://chrome.google.com/webstore/devconsole"
