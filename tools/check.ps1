# Replays the exact Ollama request the ESP32 sends, using a live ROI image from the device.
# Usage: .\check.ps1 [-ImageUrl <url>] [-OllamaUrl <url>] [-Model <model>]
#        .\check.ps1 -RawBase64  (uses the hardcoded base64 from ESP32 capture)
param(
    [string]$ImageUrl  = "http://192.168.68.103/fileserver/img_tmp/alg_roi/dig1.jpg",
    [string]$OllamaUrl = "http://192.168.68.111:11435/api/chat",
    [string]$Model     = "qwen3-vl:4b",
    [int]   $MaxTokens = 500,
    [switch]$RawBase64
)

$PROMPT = "This image shows a single digit on a utility meter display. It's a rolling meter. Some parts of other numbers maybe visible. Reply with ONLY the single digit (0-9) you see. If you cannot determine the digit, reply with the letter N."

if ($RawBase64) {
    # Exact base64 captured from ESP32 request
    $b64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRQBAwQEBQQFCQUFCRQNCw0UFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFP/AABEIAEAAKAMBIgACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/APom8n+zwNIegFcXP8SbSK6aJh93jiuo15tumzDGSRwK818K+FZrnUJLi8hxHnjPevyyUrHzWGownGTmdAPiJGxyIG2euDTJvidYpJt2kfUVvLpNuibREuPpXF+PNCsba085cRydhWaqLax1UqFKpLksdND4wgmkhReTL0q//bS15z4P3SiMkZ2/dJrrtslNO+px14eyqOJ193h1xVIyRwruYhQPwq3qDiKJn9Bk15LqmvX+t6s1ra5ETHHFEtWbYWlKre2x2OreNbOwO1T5j+grir2HUfGmoKdrLBnp7V1ujeBbW22y3R82Q8kE11UFrDax7UVUA6Vg2lsdqqQw8r09WcNfaOnh2CzEHUA7veq39sTf3TXU+IrMXLQuCPkzWN9jPt+VaR1R5NaTnNykdlr0LTadOiffI4rymz07WdInZoYCzMTzXsrpubDdKvx6bC+CNv5U5Ox04XE+xTXc8f8AM8Sj52RgKlK+IbtMHctezwaTDI4UlefarD6JBEM5WuZzWx0PFx/lPFrWW/s4Sb/JVemaf/bMPpXV/Ei1S108BQPn7jtXmGwf3z+VdFPWJxVJKpLmsezXLhEZz0AzXAan8T2jla3s0LspxkGu+1BQLSXP90ivLfCvhz7Nq9zdXaZTdlAapmuCVNKU6nQvw+LvEI/fmJhHUkHxQvILkJdblGe9dOl5Bt2bRtHtXnXxCmsnvYliAV++Ky3ex6lOdKu+Xlsd3rmqR6xYxHO4MOtc79gi9q5+fUp9O8P24Vt0xztHrWL/AMJLqv8Azy/Wt4p2PErWhNxT2P/Z"
    Write-Host "Using hardcoded base64 from ESP32 capture ($($b64.Length) chars)"
} else {
    Write-Host "Fetching image: $ImageUrl"
    try {
        $imgBytes = (Invoke-WebRequest -Uri $ImageUrl -UseBasicParsing).Content
    } catch {
        Write-Error "Failed to fetch image: $_"; exit 1
    }
    Write-Host "Image size: $($imgBytes.Length) bytes"
    $b64 = [Convert]::ToBase64String([byte[]]$imgBytes)
}

$bodyObj = [ordered]@{
    model    = $Model
    messages = @(
        [ordered]@{
            role    = "user"
            content = $PROMPT
            images  = @($b64)
        }
    )
    stream  = $false
    think   = $false
    options = [ordered]@{ temperature = 0; num_predict = $MaxTokens }
}
$bodyJson = $bodyObj | ConvertTo-Json -Depth 5

Write-Host "POSTing to $OllamaUrl (model=$Model) ..."
try {
    $resp = Invoke-RestMethod -Uri $OllamaUrl `
        -Method POST -ContentType "application/json" -Body $bodyJson
    Write-Host "--- Response ---"
    $resp | ConvertTo-Json -Depth 5
    Write-Host "--- Extracted digit ---"
    $content = $resp.message.content
    Write-Host "Content: '$content'"
} catch {
    Write-Host "HTTP error: $($_.Exception.Message)"
    try {
        $errBody = $_.ErrorDetails.Message
        if (-not $errBody) {
            $stream = $_.Exception.Response.Content.ReadAsStringAsync().Result
            $errBody = $stream
        }
        Write-Host "Body: $errBody"
    } catch {}
}