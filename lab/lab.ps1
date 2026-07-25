<#
.SYNOPSIS
    Driver for the AI datacenter seed lab.

.DESCRIPTION
    One entry point for the whole loop: render the source of truth into golden configs,
    bring up the seed, let the fabric provision itself, and prove it worked.

    ./lab.ps1 up          seed + fabric, rendering from NetBox (starts NetBox if needed)
    ./lab.ps1 up -Yaml    same, but render straight from sot/*.yml and skip NetBox
    ./lab.ps1 render      re-render golden configs only (after editing sot/)
    ./lab.ps1 verify      run the end-to-end proof
    ./lab.ps1 status      what is running and what provisioned
    ./lab.ps1 logs <dev>  ZTP log for one device
    ./lab.ps1 shell <dev> shell on a device
    ./lab.ps1 miscable    inject a mis-cabled rail (then run verify)
    ./lab.ps1 repair      undo the mis-cable
    ./lab.ps1 up -Frr     build the fabric from FRR instead of SONiC (real data plane)
    ./lab.ps1 down        stop everything, keep images
    ./lab.ps1 clean       stop everything and remove volumes and networks
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('up', 'render', 'verify', 'status', 'logs', 'shell', 'miscable',
                 'repair', 'down', 'clean', 'netbox', 'lldp-fix')]
    [string]$Command = 'up',

    [Parameter(Position = 1)]
    [string]$Device,

    [switch]$Yaml,
    [switch]$Quick,

    # Which switch personality to build the fabric from.
    #   sonic : real NOS (CONFIG_DB / SAI / syncd), control plane only, no forwarding
    #   frr   : real Linux data plane -- bridges, routing, ECMP, real throughput
    # The seed, the source of truth, the cabling and the compute nodes are identical.
    [ValidateSet('sonic', 'frr')]
    [string]$FabricProfile = 'sonic',

    [switch]$Frr
)

if ($Frr) { $FabricProfile = 'frr' }
$env:AIDC_PROFILE = $FabricProfile

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$SEED    = 'docker-compose.seed.yml'
$FABRIC  = 'docker-compose.fabric.yml'
$NETBOX  = 'docker-compose.netbox.yml'
$SONIC_IMAGE_DEFAULT = 'docker-sonic-vs:latest'

function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "!!  $m" -ForegroundColor Yellow }
function Ok($m)   { Write-Host "OK  $m" -ForegroundColor Green }

function Assert-Docker {
    docker version --format '{{.Server.Version}}' 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Docker is not running. Start Docker Desktop and retry." }
}

function Assert-SonicImage {
    $img = docker images -q $SONIC_IMAGE_DEFAULT 2>$null
    if (-not $img) {
        throw @"
SONiC image '$SONIC_IMAGE_DEFAULT' is not loaded.

Fetch and load it with:
    ./scripts/fetch-sonic-image.ps1

That downloads the current docker-sonic-vs build (~210 MB compressed) from the
SONiC project's public build pipeline and loads it into Docker.
"@
    }
}

function Invoke-Tools([string[]]$ToolArgs, [switch]$NeedsNetbox) {
    docker image inspect aidc-tools:latest 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Info "building the toolchain image"
        docker build -q -t aidc-tools:latest ./tools | Out-Null
    }
    $mount = "$($PWD.Path):/lab"
    $netArgs = @('-e', "AIDC_PROFILE=$FabricProfile")
    if ($NeedsNetbox) {
        # The generator talks to NetBox over the lab's OOB network.
        $netArgs += @('--network', 'aidc-oob', '-e', 'NETBOX_URL=http://10.10.0.11:8080')
    }
    docker run --rm -v $mount @netArgs aidc-tools:latest @ToolArgs
    if ($LASTEXITCODE -ne 0) { throw "toolchain step failed: $($ToolArgs -join ' ')" }
}

function Initialize-LabBridges {
    <#
      Make Docker's bridges behave like cables. Two settings, both required, and both
      reset every time Docker recreates the bridges -- so this runs after every `up`.

      group_fwd_mask bit 14
        LLDP is addressed to 01:80:c2:00:00:0e, inside the 802.1D reserved range a bridge
        must consume rather than forward. Without this, no device ever sees a neighbour
        and cabling validation cannot work.

      hairpin_mode 0
        Docker Desktop enables hairpin on veth ports, which reflects a frame back to the
        sender. A switch that bridges between ports then receives its own flooded frames
        and floods them again: a broadcast storm that saturates the fabric within seconds
        and starves BGP until sessions drop. Harmless for ordinary containers, fatal for
        anything doing L2 forwarding.
    #>
    $bridges = @()
    docker network ls --filter name=aidc- --format '{{.Name}}' | ForEach-Object {
        $id = docker network inspect $_ --format '{{.Id}}'
        $bridges += "br-$($id.Substring(0,12))"
    }
    if ($bridges.Count -eq 0) { return }
    $list = $bridges -join ' '
    docker run --rm --privileged --network host -v "//sys:/hostsys" `
        -e "AIDC_BRIDGES=$list" alpine:3.20 sh -c @'
lldp=0; hp=0
for dev in $AIDC_BRIDGES; do
  m="/hostsys/class/net/$dev/bridge/group_fwd_mask"
  [ -e "$m" ] && echo 0x4000 > "$m" 2>/dev/null && lldp=$((lldp+1))
  for p in /hostsys/class/net/$dev/brif/*; do
    [ -e "$p/hairpin_mode" ] || continue
    echo 0 > "$p/hairpin_mode" 2>/dev/null && hp=$((hp+1))
  done
done
echo "LLDP forwarding enabled on $lldp bridge(s); hairpin disabled on $hp port(s)"
'@
}

function Wait-ForProvisioning([int]$TimeoutSec = 300) {
    $expected = (Get-Content out/artifacts/manifest.json | ConvertFrom-Json).devices.PSObject.Properties.Name.Count
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $inv = Invoke-RestMethod -Uri 'http://localhost:8080/ztp/inventory' -TimeoutSec 5
            $n = $inv.registered.Count
            Write-Host "    provisioned $n/$expected ..." -ForegroundColor DarkGray
            if ($n -ge $expected) { Ok "all $n devices provisioned themselves from the seed"; return $true }
        } catch { Write-Host "    waiting for the seed ..." -ForegroundColor DarkGray }
        Start-Sleep -Seconds 10
    }
    Warn "timed out waiting for provisioning; run './lab.ps1 status' to see who is missing"
    return $false
}

switch ($Command) {

    'render' {
        Assert-Docker
        if ($Yaml) {
            Info "rendering golden configs from sot/*.yml (profile: $FabricProfile)"
            Invoke-Tools @('python', 'gen_configs.py', '--source', 'yaml', '--profile', $FabricProfile)
        } else {
            Info "rendering golden configs from NetBox (profile: $FabricProfile)"
            Invoke-Tools @('python', 'gen_configs.py', '--source', 'netbox', '--profile', $FabricProfile) -NeedsNetbox
        }
        Invoke-Tools @('python', 'gen_topology.py', '--profile', $FabricProfile)
        Invoke-Tools @('python', 'gen_seed.py')
        Ok "artifacts written to out/artifacts/"
    }

    'netbox' {
        Assert-Docker
        Info "starting NetBox (first boot takes a few minutes)"
        docker compose -f $SEED up -d 2>&1 | Out-Null   # oob network must exist first
        docker compose -f $NETBOX up -d
        Info "seeding NetBox from sot/*.yml"
        Invoke-Tools @('python', 'netbox_seed.py') -NeedsNetbox
        Ok "NetBox seeded -- http://localhost:18000 (admin/admin)"
    }

    'up' {
        Assert-Docker
        if ($FabricProfile -eq 'sonic') { Assert-SonicImage }

        Info "generating the topology from the cable plan (profile: $FabricProfile)"
        Invoke-Tools @('python', 'gen_topology.py', '--profile', $FabricProfile)
        Invoke-Tools @('python', 'gen_seed.py')

        if (-not $Yaml) {
            Info "starting NetBox"
            docker compose -f $SEED up -d 2>&1 | Out-Null
            docker compose -f $NETBOX up -d 2>&1 | Out-Null
            Invoke-Tools @('python', 'netbox_seed.py') -NeedsNetbox
            Info "rendering golden configs from NetBox (profile: $FabricProfile)"
            Invoke-Tools @('python', 'gen_configs.py', '--source', 'netbox', '--profile', $FabricProfile) -NeedsNetbox
        } else {
            Info "rendering golden configs from sot/*.yml (profile: $FabricProfile)"
            Invoke-Tools @('python', 'gen_configs.py', '--source', 'yaml', '--profile', $FabricProfile)
        }

        Info "starting the seed node"
        docker compose -f $SEED up -d --build
        Start-Sleep -Seconds 8

        Info "building node images and starting the fabric"
        docker compose -f $SEED -f $FABRIC up -d --build

        Info "preparing the lab bridges (LLDP forwarding, hairpin off)"
        Initialize-LabBridges

        Info "waiting for zero-touch provisioning"
        Wait-ForProvisioning | Out-Null

        Write-Host ""
        Ok "lab is up"
        Write-Host "  seed        http://localhost:8080"
        Write-Host "  grafana     http://localhost:13000  (anonymous viewer)"
        Write-Host "  prometheus  http://localhost:19090"
        if (-not $Yaml) { Write-Host "  netbox      http://localhost:18000  (admin/admin)" }
        Write-Host ""
        Write-Host "  next: ./lab.ps1 verify"
    }

    'verify' {
        Assert-Docker
        $a = @('scripts/verify.py', '--json', 'out/verify-report.json')
        if ($Quick) { $a += '--quick' }
        python @a
        exit $LASTEXITCODE
    }

    'status' {
        Assert-Docker
        Info "containers"
        docker compose -f $SEED -f $FABRIC ps --format "table {{.Name}}`t{{.Status}}"
        Write-Host ""
        Info "provisioning"
        try {
            $inv = Invoke-RestMethod -Uri 'http://localhost:8080/ztp/inventory' -TimeoutSec 5
            Write-Host "  registered : $($inv.registered -join ', ')"
            if ($inv.missing) { Warn "missing    : $($inv.missing -join ', ')" }
            if ($inv.unknown_macs.PSObject.Properties.Count) {
                Warn "unknown MACs asked for a config: $($inv.unknown_macs | ConvertTo-Json -Compress)"
            }
        } catch { Warn "seed ZTP API is not responding" }
    }

    'logs' {
        if (-not $Device) { throw "usage: ./lab.ps1 logs <device>" }
        $p = "out/state/$Device/ztp.log"
        if (-not (Test-Path $p)) { throw "no ZTP log for '$Device' at $p" }
        Get-Content $p
    }

    'shell' {
        if (-not $Device) { throw "usage: ./lab.ps1 shell <device>" }
        docker exec -it $Device bash
    }

    'miscable' { python scripts/inject-miscable.py }
    'repair'   { python scripts/inject-miscable.py --repair }
    'lldp-fix' { Assert-Docker; Initialize-LabBridges }

    'down' {
        Assert-Docker
        Info "stopping the lab"
        docker compose -f $SEED -f $FABRIC -f $NETBOX down --remove-orphans
        Ok "stopped (images and volumes kept)"
    }

    'clean' {
        Assert-Docker
        Info "removing containers, networks and volumes"
        docker compose -f $SEED -f $FABRIC -f $NETBOX down -v --remove-orphans
        docker network ls --filter name=aidc- -q | ForEach-Object { docker network rm $_ 2>&1 | Out-Null }
        Remove-Item -Recurse -Force out/state, out/seed-state -ErrorAction SilentlyContinue
        Ok "clean"
    }
}
