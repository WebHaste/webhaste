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

.PARAMETER SkipChangelog
  Don't require or update CHANGELOG.md. Normally the script refuses to
  package a new version unless CHANGELOG.md has notes for it, and moves the
  [Unreleased] section's notes under the new version heading.

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

    [switch]$SkipChangelog,

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

# The Chrome Web Store rejects a package containing more than one file named
# manifest.json ("More than one manifest found in package"), at any depth —
# so nothing under the included folders may use that name. Fail here, before
# bumping the version or writing a zip, rather than at upload time.
$strayManifests = foreach ($p in $includePaths) {
    $full = Join-Path $repoRoot $p
    if ((Test-Path $full -PathType Container)) {
        Get-ChildItem -Path $full -Recurse -File -Filter "manifest.json"
    }
}
if ($strayManifests) {
    $names = ($strayManifests | ForEach-Object { $_.FullName.Substring($repoRoot.Length).TrimStart('\') }) -join ", "
    throw "The Chrome Web Store rejects packages with more than one manifest.json. Rename: $names"
}

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

# CHANGELOG.md check — runs before anything is written, so a release can't be
# packaged without notes. Releasing a new version promotes "## [Unreleased]"
# to "## [x.y.z] - date" and leaves a fresh empty Unreleased section on top.
# Re-packaging a version that already has a section (-SkipBump) just reuses it.
$changelogPath = Join-Path $repoRoot "CHANGELOG.md"
$changelogText = $null
$releaseNotes = $null
$promoteChangelog = $false
if (-not $SkipChangelog) {
    if (-not (Test-Path $changelogPath)) {
        throw "CHANGELOG.md not found. Create it, or pass -SkipChangelog."
    }
    # Not Get-Content: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI,
    # which would mangle the emoji/dashes and write them back corrupted.
    $changelogText = [System.IO.File]::ReadAllText($changelogPath, (New-Object System.Text.UTF8Encoding($false)))
    $versionHeading = '(?m)^## \[' + [regex]::Escape($newVersion) + '\][^\r\n]*\r?\n'
    $sectionBody = '(?s)(.*?)(?=^## \[|\z)'
    $existing = [regex]::Match($changelogText, $versionHeading + $sectionBody, 'Multiline')
    if ($existing.Success) {
        $releaseNotes = $existing.Groups[1].Value.Trim()
    }
    else {
        $unreleased = [regex]::Match($changelogText, '(?m)^## \[Unreleased\][^\r\n]*\r?\n' + $sectionBody, 'Multiline')
        if (-not $unreleased.Success -or -not $unreleased.Groups[1].Value.Trim()) {
            throw "CHANGELOG.md has no [$newVersion] section and nothing under [Unreleased]. Add release notes first, or pass -SkipChangelog."
        }
        $releaseNotes = $unreleased.Groups[1].Value.Trim()
        $promoteChangelog = $true
    }
}

if ($DryRun) {
    if ($promoteChangelog) { Write-Host "(dry run - would move [Unreleased] notes into [$newVersion] in CHANGELOG.md)" }
    Write-Host "(dry run - manifest.json, CHANGELOG.md and releases\ left untouched)"
    exit 0
}

if ($promoteChangelog) {
    $today = Get-Date -Format "yyyy-MM-dd"
    $updatedChangelog = [regex]::Replace(
        $changelogText,
        '(?m)^## \[Unreleased\][^\r\n]*',
        "## [Unreleased]`n`n## [$newVersion] - $today",
        1
    )
    $utf8NoBomChangelog = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($changelogPath, $updatedChangelog, $utf8NoBomChangelog)
    Write-Host "Updated CHANGELOG.md ([Unreleased] -> [$newVersion])"
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
if ($releaseNotes) {
    Write-Host ""
    Write-Host "Release notes for v$newVersion (for the GitHub Release and the Web Store 'what's new' field):"
    Write-Host "------------------------------------------------------------"
    Write-Host $releaseNotes
    Write-Host "------------------------------------------------------------"
}
Write-Host ""
Write-Host "Next:"
Write-Host "  1. Commit manifest.json + CHANGELOG.md and push"
Write-Host "  2. Run scripts\create-github-release.ps1 (tags the commit and creates the GitHub Release)"
Write-Host "  3. Upload the zip as a new package version at https://chrome.google.com/webstore/devconsole"
Write-Host "     (paste the notes above into its 'what's new' field)"
Write-Host "  4. Add the same notes to https://chromecms.com/docs/changelog.html"
