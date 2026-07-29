param(
    [string]$RepoPath = $PSScriptRoot,
    [int]$Port = 8765,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$indexPath = Join-Path $RepoPath 'index.html'
$htmlPath = Join-Path $PSScriptRoot 'ticker-admin.html'

if (-not (Test-Path $indexPath) -or -not (Test-Path (Join-Path $RepoPath '.git'))) {
    throw "Mirai repository not found at $RepoPath"
}
if (-not (Test-Path $htmlPath)) {
    throw "Admin page not found at $htmlPath"
}

function Invoke-Git {
    param(
        [Parameter(Mandatory)]
        [string[]]$Arguments,
        [switch]$AllowFailure
    )

    $output = & git -C $RepoPath @Arguments 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0 -and -not $AllowFailure) {
        throw "git $($Arguments -join ' ') failed:`n$($output.Trim())"
    }
    [pscustomobject]@{ ExitCode = $exitCode; Output = $output.Trim() }
}

function Get-WatchlistKeys {
    $content = Get-Content -Raw -Path $indexPath
    $block = [regex]::Match($content, '(?s)const WATCHLIST = \{\r?\n(?<body>.*?)\r?\n\};')
    if (-not $block.Success) {
        throw 'Could not locate the WATCHLIST object in index.html.'
    }

    @([regex]::Matches($block.Groups['body'].Value, '(?m)^\s{2}(?<key>[a-z0-9_]+): \[[^\r\n]*\],?\r?$') |
        ForEach-Object { $_.Groups['key'].Value })
}

function Add-TickersToWatchlist {
    param(
        [Parameter(Mandatory)]
        [string]$Content,
        [Parameter(Mandatory)]
        [string]$Key,
        [Parameter(Mandatory)]
        [string[]]$Tickers
    )

    $pattern = "(?m)^(?<prefix>\s{2}$([regex]::Escape($Key)): \[)(?<items>[^\r\n]*)(?<suffix>\],?)(?=\r?$)"
    $match = [regex]::Match($Content, $pattern)
    if (-not $match.Success) {
        throw "Watchlist '$Key' was not found in index.html."
    }

    $existing = @([regex]::Matches($match.Groups['items'].Value, "'(?<ticker>[^']+)'") |
        ForEach-Object { $_.Groups['ticker'].Value })
    $updated = @($existing + $Tickers | Sort-Object -Unique)
    $items = ($updated | ForEach-Object { "'$_'" }) -join ','
    $replacement = $match.Groups['prefix'].Value + $items + $match.Groups['suffix'].Value
    $Content.Substring(0, $match.Index) + $replacement + $Content.Substring($match.Index + $match.Length)
}

function Write-JsonResponse {
    param(
        [Parameter(Mandatory)]
        [System.Net.HttpListenerContext]$Context,
        [Parameter(Mandatory)]
        [int]$StatusCode,
        [Parameter(Mandatory)]
        [object]$Body
    )

    $json = $Body | ConvertTo-Json -Depth 5
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $Context.Response.StatusCode = $StatusCode
    $Context.Response.ContentType = 'application/json; charset=utf-8'
    $Context.Response.ContentLength64 = $bytes.Length
    $Context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $Context.Response.Close()
}

function Test-RequestOrigin {
    param([System.Net.HttpListenerRequest]$Request)
    $origin = $Request.Headers['Origin']
    -not $origin -or $origin -in @("http://127.0.0.1:$Port", "http://localhost:$Port")
}

$tokenBytes = [byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Fill($tokenBytes)
$sessionToken = [Convert]::ToHexString($tokenBytes)
$listener = [Net.HttpListener]::new()
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()

if (-not $NoBrowser) {
    Start-Process "http://127.0.0.1:$Port/"
}

Write-Host "Mirai Ticker Admin is running at http://127.0.0.1:$Port/"
Write-Host 'Close this window or press Ctrl+C to stop it.'

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        try {
            $request = $context.Request
            if (-not (Test-RequestOrigin $request)) {
                Write-JsonResponse $context 403 @{ error = 'Request origin was rejected.' }
                continue
            }

            if ($request.HttpMethod -eq 'GET' -and $request.Url.AbsolutePath -eq '/') {
                $bytes = [IO.File]::ReadAllBytes($htmlPath)
                $context.Response.StatusCode = 200
                $context.Response.ContentType = 'text/html; charset=utf-8'
                $context.Response.ContentLength64 = $bytes.Length
                $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
                $context.Response.Close()
                continue
            }

            if ($request.HttpMethod -eq 'GET' -and $request.Url.AbsolutePath -eq '/api/config') {
                Write-JsonResponse $context 200 @{
                    token = $sessionToken
                    watchlists = @(Get-WatchlistKeys)
                }
                continue
            }

            if ($request.HttpMethod -eq 'POST' -and $request.Url.AbsolutePath -eq '/api/update') {
                if ($request.Headers['X-Mirai-Admin-Token'] -ne $sessionToken) {
                    Write-JsonResponse $context 403 @{ error = 'The local session token is invalid. Refresh the page.' }
                    continue
                }

                $reader = [IO.StreamReader]::new($request.InputStream, $request.ContentEncoding)
                $payload = $reader.ReadToEnd() | ConvertFrom-Json
                $tickers = @($payload.tickers.ToUpperInvariant() -split '[,\s]+' |
                    Where-Object { $_ } | Sort-Object -Unique)
                if ($tickers.Count -eq 0) {
                    throw 'Enter at least one ticker.'
                }
                $invalid = @($tickers | Where-Object { $_ -notmatch '^[A-Z][A-Z0-9.-]{0,11}$' })
                if ($invalid.Count -gt 0) {
                    throw "Invalid ticker format: $($invalid -join ', ')"
                }

                $watchlists = @(Get-WatchlistKeys)
                $target = [string]$payload.watchlist
                if ($target -notin $watchlists -or $target -in @('equities', 'etfs')) {
                    throw "Invalid watchlist: $target"
                }

                $securityType = [string]$payload.securityType
                if ($securityType -notin @('stock', 'etf', 'reit', 'bdc')) {
                    throw "Invalid security type: $securityType"
                }

                $dirty = (Invoke-Git -Arguments @('status', '--porcelain', '--untracked-files=all')).Output
                if ($dirty) {
                    Write-JsonResponse $context 409 @{
                        error = 'The Mirai repository has uncommitted changes. Commit or discard them before publishing with this tool.'
                    }
                    continue
                }

                Invoke-Git -Arguments @('pull', '--ff-only', 'origin', 'main') | Out-Null
                $ahead = [int](Invoke-Git -Arguments @('rev-list', '--count', 'origin/main..HEAD')).Output
                $publishedPendingCommit = $false
                if ($ahead -gt 0) {
                    try {
                        Invoke-Git -Arguments @('push', 'origin', 'main') | Out-Null
                        $publishedPendingCommit = $true
                    } catch {
                        Write-JsonResponse $context 502 @{
                            error = "A previous update is committed locally but could not be published. Check your network or Git credentials, then submit again. Details: $($_.Exception.Message)"
                        }
                        continue
                    }
                }

                $originalContent = Get-Content -Raw -Path $indexPath
                $content = $originalContent
                $updateKeys = @($target)
                if ($securityType -eq 'etf') { $updateKeys += 'etfs' }
                if ($securityType -eq 'reit') { $updateKeys += 'reit' }
                if ($securityType -eq 'bdc') { $updateKeys += 'bdc' }
                $updateKeys = @($updateKeys | Sort-Object -Unique)

                foreach ($key in $updateKeys) {
                    $content = Add-TickersToWatchlist -Content $content -Key $key -Tickers $tickers
                }
                [IO.File]::WriteAllText($indexPath, $content, [Text.UTF8Encoding]::new($false))

                $diff = (Invoke-Git -Arguments @('diff', '--', 'index.html')).Output
                if (-not $diff) {
                    $message = if ($publishedPendingCommit) {
                        "Published a previously pending update. $($tickers -join ', ') already existed in the selected lists."
                    } else {
                        "$($tickers -join ', ') already existed in the selected lists. Nothing was published."
                    }
                    Write-JsonResponse $context 200 @{
                        message = $message
                    }
                    continue
                }

                $commitCreated = $false
                try {
                    Invoke-Git -Arguments @('diff', '--check', '--', 'index.html') | Out-Null
                    Invoke-Git -Arguments @('add', '--', 'index.html') | Out-Null
                    $message = "Add $($tickers -join ', ') to $target watchlist"
                    Invoke-Git -Arguments @('commit', '-m', $message) | Out-Null
                    $commitCreated = $true
                    Invoke-Git -Arguments @('push', 'origin', 'main') | Out-Null
                } catch {
                    if (-not $commitCreated) {
                        Invoke-Git -Arguments @('restore', '--staged', '--', 'index.html') -AllowFailure | Out-Null
                        [IO.File]::WriteAllText($indexPath, $originalContent, [Text.UTF8Encoding]::new($false))
                        throw "The update failed and was rolled back. Details: $($_.Exception.Message)"
                    }
                    throw "The update was committed locally, but GitHub publishing failed. Reopen this tool and submit again to retry the pending push. Details: $($_.Exception.Message)"
                }

                Write-JsonResponse $context 200 @{
                    message = "Published $($tickers -join ', ') to $target. GitHub Pages should refresh within a few minutes."
                }
                continue
            }

            Write-JsonResponse $context 404 @{ error = 'Not found.' }
        } catch {
            if ($context.Response.OutputStream.CanWrite) {
                Write-JsonResponse $context 500 @{ error = $_.Exception.Message }
            }
        }
    }
} finally {
    $listener.Stop()
    $listener.Close()
}
