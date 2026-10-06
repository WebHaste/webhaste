<#
.SYNOPSIS
  Creates the GitHub Release (and its vX.Y.Z tag) for the version in manifest.json.

.DESCRIPTION
  Run this AFTER package-extension.ps1 has bumped the version and you've
  committed and pushed that bump. It tags HEAD, uses the matching
  CHANGELOG.md section as the release notes, and marks the release Latest.
  No zip is attached: GitHub already offers source zip/tar.gz downloads for
  the tagged commit, and the package zip is for the Chrome Web Store.

  It refuses to run unless the release would match what actually shipped:
  clean working tree, HEAD pushed to its upstream, a CHANGELOG.md section
  for the version, and no existing tag with that name (locally or on origin).
  Requires the GitHub CLI (gh) to be installed and logged in.

.PARAMETER Version
  Release a specific version (e.g. "0.7.0") instead of the one in
  manifest.json. It must still match a "## [x.y.z]" section in CHANGELOG.md.

.PARAMETER DryRun
  Run every check and print what would be created, without creating anything.

.EXAMPLE
  scripts\create-github-release.ps1

.EXAMPLE
  scripts\create-github-release.ps1 -DryRun
#>
param(
    [string]$Version,

    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

# Native commands don't throw under $ErrorActionPreference, so check exit
# codes by hand. Output is returned as a single trimmed string.
function Invoke-Git {
    $out = & git @args
    if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') failed (exit $LASTEXITCODE)" }
    if ($null -eq $out) { return "" }
    return (($out | Out-String).Trim())
}

if (-not $DryRun -and -not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw "The GitHub CLI (gh) isn't installed or isn't on PATH. See https://cli.github.com"
}

# Version: from manifest.json unless given.
if (-not $Version) {
    $manifestPath = Join-Path $repoRoot "manifest.json"
    $manifestText = [System.IO.File]::ReadAllText($manifestPath)
    $m = [regex]::Match($manifestText, '"version"\s*:\s*"(\d+\.\d+\.\d+)"')
    if (-not $m.Success) { throw "Could not find a version in manifest.json" }
    $Version = $m.Groups[1].Value
}
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "-Version must look like x.y.z (got '$Version')" }
$tag = "v$Version"

$problems = @()

# 1. Clean working tree — the tag must describe exactly what's committed.
$dirty = Invoke-Git status --porcelain
if ($dirty) {
    $problems += "Working tree has uncommitted changes. Commit the version bump (manifest.json + CHANGELOG.md) first:`n$dirty"
}

# 2. HEAD must already be on the remote, or GitHub would have no commit to tag.
$head = Invoke-Git rev-parse HEAD
$upstream = & git rev-parse --abbrev-ref --symbolic-full-name "@{u}" 2>$null
if ($LASTEXITCODE -ne 0 -or -not $upstream) {
    $problems += "The current branch has no upstream. Push it first."
}
else {
    & git fetch --quiet 2>$null
    $unpushed = Invoke-Git rev-list "$upstream..HEAD" --count
    if ([int]$unpushed -gt 0) {
        $problems += "HEAD has $unpushed commit(s) not pushed to $upstream. Push before releasing."
    }
}

# 3. Tag must not exist yet, locally or on origin.
if (& git tag --list $tag) { $problems += "Tag $tag already exists locally." }
$remoteTag = & git ls-remote --tags origin "refs/tags/$tag" 2>$null
if ($remoteTag) { $problems += "Tag $tag already exists on origin." }

# 4. Release notes from CHANGELOG.md's [version] section. Read through .NET as
# UTF-8 — Windows PowerShell 5.1's Get-Content would mangle emoji/dashes.
$changelogPath = Join-Path $repoRoot "CHANGELOG.md"
$notes = $null
if (-not (Test-Path $changelogPath)) {
    $problems += "CHANGELOG.md not found."
}
else {
    $changelog = [System.IO.File]::ReadAllText($changelogPath, (New-Object System.Text.UTF8Encoding($false)))
    $section = [regex]::Match(
        $changelog,
        '(?ms)^## \[' + [regex]::Escape($Version) + '\][^\r\n]*\r?\n(.*?)(?=^## \[|\z)'
    )
    if (-not $section.Success -or -not $section.Groups[1].Value.Trim()) {
        $problems += "CHANGELOG.md has no notes under [$Version]. Run package-extension.ps1 first (it promotes [Unreleased])."
    }
    else {
        $notes = $section.Groups[1].Value.Trim()
    }
}

Write-Host "Version:  $Version  (tag $tag)"
Write-Host "Commit:   $($head.Substring(0, 7))"

if ($problems.Count -gt 0) {
    Write-Host ""
    Write-Host "Can't create the release yet:" -ForegroundColor Red
    foreach ($p in $problems) { Write-Host "  - $p" }
    exit 1
}

Write-Host ""
Write-Host "Release notes:"
Write-Host "------------------------------------------------------------"
Write-Host $notes
Write-Host "------------------------------------------------------------"

if ($DryRun) {
    Write-Host "(dry run - nothing created)"
    exit 0
}

# Notes go through a file rather than --notes so quoting and non-ASCII
# characters can't be mangled on the way into gh.
$notesFile = [System.IO.Path]::GetTempFileName()
try {
    [System.IO.File]::WriteAllText($notesFile, $notes, (New-Object System.Text.UTF8Encoding($false)))
    & gh release create $tag --target $head --title "WebHaste $Version" --notes-file $notesFile --latest
    if ($LASTEXITCODE -ne 0) { throw "gh release create failed (exit $LASTEXITCODE)" }
}
finally {
    Remove-Item $notesFile -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Created GitHub Release $tag."
Write-Host "Don't forget: upload the zip to the Web Store and add this version to https://chromecms.com/docs/changelog.html"
