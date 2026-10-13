# Replays the exact Ollama request the ESP32 sends, using a live ROI image from the device.
# Usage: .\check.ps1 [-ImageUrl <url>] [-OllamaUrl <url>] [-Model <model>]
#        .\check.ps1 -RawBase64  (uses the hardcoded base64 from ESP32 capture)
param(
    [string]$ImageUrl  = "http://192.168.68.103/fileserver/img_tmp/alg_roi/dig1.jpg",
    [string]$OllamaUrl = "http://192.168.68.111:4000/api/chat",
    [string]$Model     = "qwen3-vl",
    [int]   $MaxTokens = 500,
    [switch]$RawBase64
)

$PROMPT = "This image shows a single digit on a utility meter display. It's a rolling meter. Some parts of other numbers maybe visible. Reply with ONLY the single digit (0-9) you see. If you cannot determine the digit, reply with the letter N."

if ($RawBase64) {
    # Exact base64 captured from ESP32 request
    # $b64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRQBAwQEBQQFCQUFCRQNCw0UFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFP/AABEIAEAAKAMBIgACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/APom8n+zwNIegFcXP8SbSK6aJh93jiuo15tumzDGSRwK818K+FZrnUJLi8hxHnjPevyyUrHzWGownGTmdAPiJGxyIG2euDTJvidYpJt2kfUVvLpNuibREuPpXF+PNCsba085cRydhWaqLax1UqFKpLksdND4wgmkhReTL0q//bS15z4P3SiMkZ2/dJrrtslNO+px14eyqOJ193h1xVIyRwruYhQPwq3qDiKJn9Bk15LqmvX+t6s1ra5ETHHFEtWbYWlKre2x2OreNbOwO1T5j+grir2HUfGmoKdrLBnp7V1ujeBbW22y3R82Q8kE11UFrDax7UVUA6Vg2lsdqqQw8r09WcNfaOnh2CzEHUA7veq39sTf3TXU+IrMXLQuCPkzWN9jPt+VaR1R5NaTnNykdlr0LTadOiffI4rymz07WdInZoYCzMTzXsrpubDdKvx6bC+CNv5U5Ox04XE+xTXc8f8AM8Sj52RgKlK+IbtMHctezwaTDI4UlefarD6JBEM5WuZzWx0PFx/lPFrWW/s4Sb/JVemaf/bMPpXV/Ei1S108BQPn7jtXmGwf3z+VdFPWJxVJKpLmsezXLhEZz0AzXAan8T2jla3s0LspxkGu+1BQLSXP90ivLfCvhz7Nq9zdXaZTdlAapmuCVNKU6nQvw+LvEI/fmJhHUkHxQvILkJdblGe9dOl5Bt2bRtHtXnXxCmsnvYliAV++Ky3ex6lOdKu+Xlsd3rmqR6xYxHO4MOtc79gi9q5+fUp9O8P24Vt0xztHrWL/AMJLqv8Azy/Wt4p2PErWhNxT2P/Z"
    $b64 =  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRQBAwQEBQQFCQUFCRQNCw0UFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFP/AABEIAEAAKAMBIgACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/ANiRyFznA9aq/wBoW+cNcKCKo+KZJIdKYxkg+orzNnkkJLM2frXHCHMfR4zGzoVXBHq73toT/wAfK1BLe2Y/5eVrzaw0q51W5WKEucnnmui1vwFNpmkG4Z23AZ61r7M89ZpVvY3n1G0z/wAfC03+0bT/AJ+FryCSWQORubj3pvmy/wB5vzo9kH9qVj3XxDbb9Kl47V53pOhtqeoCEHaCe9es63bj+z5B7V50lvJbzl422MD2opbEZs/9oOpmFj4NtVWLa9ye9amqtJqngmW4fqw4rz+eKW5lDTSFjnvXqKW6t8PyB/drc8Nux87XNuySNgd6g8t/St2+h8uR8DuaqYoKufR974fn1CLyox8zcAVWj/Z58U3qedDa7o25B3CuvvmawTzYvvDkVUn+L/iOyjEVvdlEXttFYUtj1s0d65xl78B/E9pIBJZ/+PCuvb4f6nY+C2tp49km3pmqE3xm1+Qjz7jef90VLqXxbub3SjHK2ZMdcVtqePueMeI/BF7pELzTphM9a5j7Gtd54s8XXOr2T28p+XPpXE/jTGfWPiPR7m0sWZ04x2rzOWcvMY1TLZr2fSLybUf9GvD5iPxkis3XPh1aaPO1xHJuL84x0rJLlR6FRyxk+ZHnEfh5Z490pCE+tc94i0p9MiaQDcnqK7+/8Ni7kyZyuOwqrqHh2OWyNu77l9TT9p0D6lUPC9QvEuMjHNUMJXp9z8NLQuSsnX2qD/hWtt/z0/Sj2iLWAqH/2Q=="
    
    #"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"
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

###
###   Two reasonable conventions — pick one:

#   A) "Report whichever digit dominates the centre" — matches how the digit-CNN was trained:

#   This image shows a single digit on a mechanical rolling utility meter.
#   The digit may be mid-roll, with parts of two digits visible at once
#   (one rolling up and out, the next rolling in from below). Reply with
#   ONLY the single digit (0-9) whose body occupies the centre of the image.
#   If both digits look equally visible, prefer the lower digit (the older
#   value, before the roll completes). If you genuinely cannot tell, reply N.
#   Do not explain, do not describe — just one character.

#   B) "Always round down to the previous reading" — safer for cumulative meters because you never over-count:

#   This image shows a single digit on a mechanical rolling utility meter.
#   If the meter is mid-transition and two digits are partially visible,
#   reply with the LOWER digit (the value before the meter advances).
#   Otherwise reply with the digit shown. Output ONLY one character —
#   a digit 0-9, or N if unreadable. No words, no description.
###