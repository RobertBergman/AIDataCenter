<#
.SYNOPSIS
    Download and load the SONiC virtual switch image.

.DESCRIPTION
    There is no official docker-sonic-vs image on Docker Hub. The community mirrors that
    do exist are years stale, so this pulls the current build straight from the SONiC
    project's public Azure pipeline (~210 MB compressed, ~840 MB loaded).

    ./scripts/fetch-sonic-image.ps1                 # latest 202511 release branch
    ./scripts/fetch-sonic-image.ps1 -Branch master  # master
#>
[CmdletBinding()]
param(
    [string]$Branch = '202511',
    [string]$OutDir = "$PSScriptRoot/../images"
)

$ErrorActionPreference = 'Stop'

# Pipeline 142 is Azure.sonic-buildimage.official.vs -- the virtual-switch platform build.
$PipelineId = 142
$ApiBase = 'https://dev.azure.com/mssonic/build/_apis'

Write-Host "==> finding the latest successful $Branch build" -ForegroundColor Cyan
$builds = Invoke-RestMethod -Uri ("$ApiBase/build/builds?definitions=$PipelineId" +
    "&statusFilter=completed&resultFilter=succeeded&`$top=25&api-version=7.0")

$build = $builds.value | Where-Object { $_.sourceBranch -eq "refs/heads/$Branch" } |
         Select-Object -First 1
if (-not $build) { throw "no successful build found for branch '$Branch'" }
Write-Host "    build $($build.buildNumber) ($($build.finishTime.Substring(0,10)))"

$artifacts = Invoke-RestMethod -Uri "$ApiBase/build/builds/$($build.id)/artifacts?api-version=7.0"
$artifact = $artifacts.value | Where-Object { $_.name -like '*vs*' } | Select-Object -First 1
if (-not $artifact) { throw "build $($build.id) has no virtual-switch artifact" }

# The whole artifact is tens of GB; subPath pulls just the image out of it.
$base = $artifact.resource.downloadUrl.Split('?')[0]
$url = "$base`?format=file&subPath=%2Ftarget%2Fdocker-sonic-vs.gz"

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$dest = Join-Path $OutDir 'docker-sonic-vs.gz'

Write-Host "==> downloading docker-sonic-vs.gz" -ForegroundColor Cyan
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest -Uri $url -OutFile $dest
$sizeMB = [math]::Round((Get-Item $dest).Length / 1MB, 1)
Write-Host "    $sizeMB MB -> $dest"

Write-Host "==> loading into Docker (takes a minute)" -ForegroundColor Cyan
docker load -i $dest
if ($LASTEXITCODE -ne 0) { throw "docker load failed" }

docker images docker-sonic-vs --format "    loaded: {{.Repository}}:{{.Tag}} ({{.Size}})"
Write-Host "OK  ready -- run ./lab.ps1 up" -ForegroundColor Green
