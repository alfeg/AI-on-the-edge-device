# Parameter `AdditionalHeaders`
Default Value: `undefined`

!!! Warning
    This is an **Expert Parameter**! Only change it if you understand what it does!

Pipe-separated list of extra HTTP headers in `Name=Value` format, included in every request.

Example: `X-Org-ID=org-abc123|X-Project=watermeter`

Useful for API gateways or proxies that require custom authentication or routing headers. Leave empty if not needed.
