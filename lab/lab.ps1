<#
.SYNOPSIS
    Driver for the AI datacenter seed lab.

.DESCRIPTION
    One entry point for the whole loop: render the source of truth into golden configs,
    bring up the seed, let the fabric provision itself, and prove it worked.

    COMMANDS
      up                  render, boot the seed, let the fabric provision itself
      render              re-render golden configs only (after editing sot/)
      verify              run the end-to-end proof
      status              what is running, and what provisioned
      logs <device>       ZTP log for one device
      shell <device>      shell on a device
      miscable            cross two rails, so the cabling check can be seen to fail
      repair              undo the mis-cable
      netbox              start NetBox and seed it from sot/*.yml
      bridges             re-apply the Docker bridge fixups (LLDP, hairpin)
      down                stop everything, keep images and volumes
      clean               stop everything and remove volumes, networks and generated files

    OPTIONS
      -Frr                build the fabric from FRR instead of SONiC-VS.
                          FRR gives a real Linux data plane (bridging, routing, ECMP,
                          measurable throughput); SONiC-VS gives real NOS internals
                          (CONFIG_DB, SAI, syncd) but forwards no packets.
                          Same seed, same source of truth, same cabling either way.
      -Yaml               render straight from sot/*.yml and skip NetBox entirely
      -Quick              verify: skip the reachability and throughput probes

    EXAMPLES
      ./lab.ps1 up                 # SONiC fabric, NetBox as the source of truth
      ./lab.ps1 up -Frr            # FRR fabric -- proves the data plane
      ./lab.ps1 up -Frr -Yaml      # no NetBox, no SONiC image needed
      ./lab.ps1 verify
      ./lab.ps1 miscable; ./lab.ps1 verify; ./lab.ps1 repair

    REQUIREMENTS
      Docker Desktop, ~8 GB free RAM, and Python 3 on PATH (verify / miscable only).
      The SONiC profile also needs the SONiC-VS image: ./scripts/fetch-sonic-image.ps1
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('up', 'render', 'verify', 'status', 'logs', 'shell', 'miscable',
                 'repair', 'down', 'clean', 'netbox', 'bridges', 'lldp-fix')]
    [string]$Command = 'up',

    [Parameter(Position = 1)]
    [string]$Device,

    [switch]$Yaml,
    [switch]$Quick,

    # Which switch personality to build the fabric from.
    [ValidateSet('sonic', 'frr')]
    [string]$FabricProfile = 'sonic',

    [switch]$Frr
)

if ($Frr) { $FabricProfile = 'frr' }
$env:AIDC_PROFILE = $FabricProfile

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$PROJECT = 'aidc-lab'
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

function Assert-Python {
    Get-Command python -ErrorAction SilentlyContinue | Out-Null
    if (-not $?) {
        throw "This command needs Python 3 on PATH. Everything else in the lab runs in containers."
    }
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

Or skip it entirely and run the FRR profile instead:
    ./lab.ps1 up -Frr
"@
    }
}

# docker-compose.fabric.yml is generated from the cable plan and is not in git, so it is
# absent on a fresh clone. Commands that only need to address running containers use the
# project name instead of the file list; commands that create things generate it first.
function Get-ComposeFiles([switch]$WithNetbox) {
    $a = @('-f', $SEED)
    if (Test-Path $FABRIC) { $a += @('-f', $FABRIC) }
    if ($WithNetbox)       { $a += @('-f', $NETBOX) }
    return $a
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
        # The generator reaches NetBox over the lab's OOB network, which only exists once
        # the seed stack has been created.
        $net = docker network ls --filter name=aidc-oob --format '{{.Name}}' 2>$null
        if (-not $net) {
            throw "NetBox is not reachable: the aidc-oob network does not exist yet. Run './lab.ps1 netbox' first, or use -Yaml to bypass NetBox."
        }
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
    if ($bridges.Count -eq 0) { Warn "no lab networks exist yet"; return }
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

function Get-RenderedProfile {
    if (-not (Test-Path 'out/artifacts/manifest.json')) { return $null }
    try { return (Get-Content 'out/artifacts/manifest.json' -Raw | ConvertFrom-Json).profile }
    catch { return $null }
}

function Wait-ForProvisioning([int]$TimeoutSec = 420) {
    $expected = (Get-Content out/artifacts/manifest.json -Raw | ConvertFrom-Json).devices.PSObject.Properties.Name.Count
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
        # The seed serves out/artifacts straight from a bind mount, and the generator
        # rewrites in place, so a re-render is picked up with no restart.
        Ok "artifacts written to out/artifacts/"
    }

    'netbox' {
        Assert-Docker
        Info "starting NetBox (first boot takes a few minutes)"
        docker compose -f $SEED up -d 2>&1 | Out-Null   # creates aidc-oob
        docker compose -f $NETBOX up -d
        Info "seeding NetBox from sot/*.yml"
        Invoke-Tools @('python', 'netbox_seed.py') -NeedsNetbox
        Ok "NetBox seeded -- http://localhost:18000 (admin/admin)"
    }

    'up' {
        Assert-Docker
        if ($FabricProfile -eq 'sonic') { Assert-SonicImage }

        $previous = Get-RenderedProfile
        if ($previous -and $previous -ne $FabricProfile) {
            Warn "switching profile: $previous -> $FabricProfile (containers will be recreated)"
        }

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
        Ok "lab is up (profile: $FabricProfile)"
        Write-Host "  seed        http://localhost:8080"
        Write-Host "  grafana     http://localhost:13000  (anonymous viewer)"
        Write-Host "  prometheus  http://localhost:19090"
        if (-not $Yaml) { Write-Host "  netbox      http://localhost:18000  (admin/admin)" }
        Write-Host ""
        Write-Host "  next: ./lab.ps1 verify"
    }

    'verify' {
        Assert-Docker
        Assert-Python
        if (-not (Test-Path 'out/artifacts/manifest.json')) {
            throw "nothing has been rendered yet -- run './lab.ps1 up' first."
        }
        $a = @('scripts/verify.py', '--json', 'out/verify-report.json')
        if ($Quick) { $a += '--quick' }
        python @a
        exit $LASTEXITCODE
    }

    'status' {
        Assert-Docker
        $p = Get-RenderedProfile
        Info "containers$(if ($p) { "  (profile: $p)" })"
        # Addressed by project name, not by file: the fabric compose file is generated and
        # will not exist on a fresh clone.
        docker compose -p $PROJECT ps --format "table {{.Name}}`t{{.Status}}"
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

    'miscable' { Assert-Python; python scripts/inject-miscable.py }
    'repair'   { Assert-Python; python scripts/inject-miscable.py --repair }

    { $_ -in 'bridges', 'lldp-fix' } { Assert-Docker; Initialize-LabBridges }

    'down' {
        Assert-Docker
        Info "stopping the lab"
        # By project, so this works without the generated fabric file and takes NetBox
        # with it -- every compose file in this lab declares the same project name.
        docker compose -p $PROJECT down --remove-orphans
        Ok "stopped (images and volumes kept)"
    }

    'clean' {
        Assert-Docker
        Info "removing containers, networks, volumes and generated files"
        docker compose -p $PROJECT down -v --remove-orphans
        docker network ls --filter name=aidc- -q | ForEach-Object { docker network rm $_ 2>&1 | Out-Null }
        Remove-Item -Recurse -Force out, seed/generated, seed/tftpboot/ipxe -ErrorAction SilentlyContinue
        Remove-Item -Force $FABRIC -ErrorAction SilentlyContinue
        Ok "clean -- next './lab.ps1 up' starts from scratch"
    }
}
