# Start Chrome with remote debugging support
# Usage: .\start-chrome.ps1
#   .\start-chrome.ps1                    # default: port 9222, 15s wait + 15s retry
#   .\start-chrome.ps1 -WaitSeconds 20    # custom wait time
#
# Cold start typically needs 5-15s; this script waits up to 30s total (15+15 retry).

param(
    [int]$Port = 9222,
    [string]$ChromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe",
    [string]$UserDataDir = "$env:LOCALAPPDATA\Google\Chrome\User Data",
    [int]$WaitSeconds = 15
)

$totalMax = $WaitSeconds + 15

Write-Host "[Step 1/3] Stopping existing Chrome processes..."
Get-Process "chrome" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 3
Write-Host "  Chrome processes stopped."

Write-Host "[Step 2/3] Starting Chrome with remote debugging on port $Port..."
try {
    Start-Process $ChromePath -ArgumentList @(
        "--remote-debugging-port=$Port",
        "--no-sandbox",
        "--user-data-dir=$UserDataDir"
    )
} catch {
    Write-Error "Failed to start Chrome: $_"
    exit 1
}

function Test-Port {
    param([int]$Port)
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:$Port/json/version" -UseBasicParsing -TimeoutSec 2
        if ($response.StatusCode -eq 200) {
            $data = $response.Content | ConvertFrom-Json
            Write-Host "  Chrome ready! Browser WS: $($data.webSocketDebuggerUrl)"
            return $true
        }
    } catch { }
    return $false
}

Write-Host "[Step 3/3] Waiting for Chrome to be ready (max ${totalMax}s)..."
$elapsed = 0
$ready = $false
while ($elapsed -lt $WaitSeconds) {
    if (Test-Port -Port $Port) { $ready = $true; break }
    Start-Sleep 1
    $elapsed++
}

# Retry phase: Chrome process was started but may still be loading
if (-not $ready) {
    Write-Host "  First ${WaitSeconds}s passed, retrying for up to 15 more seconds..."
    while ($elapsed -lt $totalMax) {
        if (Test-Port -Port $Port) { $ready = $true; break }
        Start-Sleep 2
        $elapsed += 2
    }
}

if (-not $ready) {
    Write-Error "Chrome did not become ready within ${totalMax}s."
    Write-Host "  TIP: Try a longer wait with -WaitSeconds 30"
    exit 1
}

Write-Host "Done."
exit 0
