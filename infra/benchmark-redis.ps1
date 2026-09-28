<#
.SYNOPSIS
Run paired Redis-beta HTTP trials in fresh containers and save raw evidence.
.DESCRIPTION
Requires a launcher installation with Redis-beta enabled. Only new disposable
benchmark containers are created. Existing Redis keys, data and services are
never removed. Each repeat has a unique namespace; miss then hit share that
namespace. Run after the application images have been prepared.
#>
param(
    [Parameter(Mandatory=$true)][string]$InstallationRoot,
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [int]$Repeats = 3,
    [int]$BudgetMs = 1000,
    [switch]$Outage
)
$ErrorActionPreference = 'Stop'
$benchmarkRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$installationPath = (Resolve-Path $InstallationRoot).Path
$config = Get-Content -LiteralPath (Join-Path $installationPath '.launch/compose.json') -Raw | ConvertFrom-Json
$record = Get-Content -LiteralPath (Join-Path $installationPath '.launch/installation.json') -Raw | ConvertFrom-Json
$routerImage = $config.services.router.image
$redisContainer = "$($record.project)-redis-1"
$network = "$($record.project)_default"
$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $outputPath | Out-Null
$prefix = 'benchmark-' + [guid]::NewGuid().ToString('N')
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Read-RedisStatistics {
    $lines = & docker exec $redisContainer sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --raw INFO'
    if ($LASTEXITCODE -ne 0) { throw 'Redis statistics failed' }
    $values = @{}
    foreach ($line in $lines) {
        if ($line -match '^([^#\s:]+):(.+)$') { $values[$matches[1]] = $matches[2].Trim() }
    }
    return @{
        used_memory_bytes = [long]$values['used_memory']
        used_memory_rss_bytes = [long]$values['used_memory_rss']
        used_cpu_sec = [double]$values['used_cpu_sys'] + [double]$values['used_cpu_user']
        keyspace = $values['db0']
    }
}

$manifest = @{
    created_at_utc = [DateTime]::UtcNow.ToString('o')
    image = $routerImage
    repeats = $Repeats
    budget_ms = $BudgetMs
    outage_requested = [bool]$Outage
    docker = (& docker version --format '{{.Server.Version}}')
    cpu_limit = 2
    memory_limit = '1536m'
    methodology = 'Fresh Linux container per trial; HTTP loopback, official east data. Off and miss alternate order. Hit follows miss in the same unique namespace. Warm means five further requests in the same process. Redis stats include idle resident overhead. Host load is uncontrolled.'
    trials = @()
}
for ($repeat = 1; $repeat -le $Repeats; $repeat++) {
    $modes = if ($Outage) { @('outage') } elseif ($repeat % 2 -eq 1) { @('off', 'miss', 'hit') } else { @('miss', 'off', 'hit') }
    foreach ($mode in $modes) {
        $label = "$repeat-$mode"
        $envPath = Join-Path $outputPath "$prefix.env"
        $environment = @(
            ('ROUTER_REDIS_BETA=' + ($mode -ne 'off').ToString().ToLowerInvariant()),
            "ROUTER_REDIS_URL=$($config.services.router.environment.ROUTER_REDIS_URL)",
            "ROUTER_REDIS_NAMESPACE=$prefix-$repeat",
            'ROUTER_REDIS_TTL_SEC=600',
            'ROUTER_OTEL_ENABLED=false',
            'ROUTER_SENTRY_ENABLED=false',
            'PYTHONDONTWRITEBYTECODE=1'
        )
        [System.IO.File]::WriteAllLines($envPath, $environment, $utf8)
        $before = Read-RedisStatistics
        $paused = $false
        try {
            if ($Outage) {
                & docker pause $redisContainer | Out-Null
                if ($LASTEXITCODE -ne 0) { throw 'Cannot pause benchmark Redis' }
                $paused = $true
            }
            & docker run --rm --name "$prefix-$label" --label 'navix.benchmark=redis-beta' `
                --label "com.docker.compose.project=$prefix" --label 'com.docker.compose.service=benchmark' `
                --network $network --cpus 2 --memory 1536m --env-file $envPath `
                --mount "type=bind,source=$benchmarkRoot,target=/work,readonly" `
                --mount "type=bind,source=$outputPath,target=/results" `
                --workdir /work --entrypoint python $routerImage -m core.redis_benchmark `
                --budget-ms $BudgetMs --label $label --output "/results/$label.json"
            if ($LASTEXITCODE -ne 0) { throw "Benchmark $label failed" }
        } finally {
            if ($paused) { & docker unpause $redisContainer | Out-Null }
            Remove-Item -LiteralPath $envPath -ErrorAction SilentlyContinue
        }
        $after = Read-RedisStatistics
        $trial = Get-Content -LiteralPath (Join-Path $outputPath "$label.json") -Raw | ConvertFrom-Json
        $expected = switch ($mode) {
            'off' { -not $trial.cache.enabled }
            'miss' { $trial.cache.writes -eq 1 -and $trial.cache.hits -eq 0 -and $trial.cache.errors -eq 0 }
            'hit' { $trial.cache.hits -eq 1 -and $trial.cache.writes -eq 0 -and $trial.cache.errors -eq 0 }
            'outage' { $trial.cache.errors -eq 2 -and $trial.cache.hits -eq 0 }
        }
        if (-not $expected) { throw "Unexpected cache counters for $label" }
        $manifest.trials += @{
            label = $label
            redis_before = $before
            redis_after = $after
            redis_cpu_sec = $after.used_cpu_sec - $before.used_cpu_sec
            expected_cache = $mode
            cache = $trial.cache
        }
        [System.IO.File]::WriteAllText((Join-Path $outputPath 'manifest.json'),
            ($manifest | ConvertTo-Json -Depth 8), $utf8)
    }
}
$trials = @(Get-ChildItem -LiteralPath $outputPath -Filter '*-*.json' | ForEach-Object {
    Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json
})
foreach ($field in @('code_version', 'input_hash', 'graph_hash', 'active_plan_digest', 'comparison_digest', 'catalog_plans_digest')) {
    if (@($trials | ForEach-Object { $_.$field } | Sort-Object -Unique).Count -ne 1) {
        throw "Trials differ in $field; inspect raw results before claiming equal quality."
    }
}
Write-Output "Saved $($manifest.trials.Count) trials; all semantic digests match."
