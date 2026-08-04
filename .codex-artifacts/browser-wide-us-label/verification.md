# Browser-wide US label verification

## Baseline
Command: `node --test tests/*.test.cjs`  
Exit: `0`
```text
✔ background applies, reports and clears a phase proxy (11.0806ms)
✔ background acquires official checkout Sentinel headers in the ChatGPT main world (0.966ms)
✔ background supplies credentials when the proxy challenger uses a resolved host (1.238ms)
✔ background preflight reports Chrome proxy network errors (50.0948ms)
✔ background preflight accepts any HTTP response reached through the proxy (28.7912ms)
✔ background probes exit IP outside the page CSP and parses Cloudflare trace (1.977ms)
✔ background routes Chrome through the local Mihomo chain relay when available (2.3985ms)
✔ background initializes a Stripe hosted payment page from a Checkout Session (3.4435ms)
✔ background records only sanitized checkout diagnostics through the local relay (2.068ms)
✔ content script mounts the two proxy pools and keeps submit disabled initially (8.0687ms)
✔ content script manually applies a US proxy from pool 1 to the current page (9.8598ms)
✔ content script creates a US baseline, applies the promotion through TR, and opens only oaics (79.5137ms)
✔ content script restores and saves proxy pools with chrome.storage.local (322.8266ms)
✔ buildCheckoutPayload returns the expected request body (1.992ms)
✔ checkout payload builders separate the US baseline from the TR promotion (0.2979ms)
✔ promotion payload accepts the campaign selected from account status (0.3256ms)
✔ PH_SHORT payload contains only the minimal pricing-route fields (0.2318ms)
✔ promotion update payload applies the campaign to an existing OAICS session (0.7105ms)
✔ account promotion context follows account ordering and exposes only safe eligibility fields (1.2386ms)
✔ payment method preflight keeps eligibility and method types without identifiers (0.2711ms)
✔ promotion detection distinguishes the verified PH_SHORT discount from a zero-discount checkout (0.1952ms)
✔ buildCheckoutPayload returns a fresh nested object (0.1754ms)
✔ buildCheckoutUrl validates and encodes the session id (0.3191ms)
✔ resolveHostedCheckoutUrl accepts official processor URLs and rejects unsafe fallbacks (0.5385ms)
✔ checkout session helpers support Stripe init and two safe fallbacks (1.5807ms)
✔ checkout session helpers accept opaque and nested OpenAI session identifiers (0.3806ms)
✔ oaics identifiers are preferred for ChatGPT internal checkout links (0.3527ms)
✔ requireOpenAICheckoutSession rejects Stripe provider responses (0.1965ms)
✔ promotion summary preserves eligibility decisions without session identifiers (0.9043ms)
✔ parseProxyLine supports authenticated HTTP and SOCKS proxies (0.5876ms)
✔ parseProxyPool validates line numbers, limits and rotates by cursor (0.6427ms)
✔ formatProxyEndpoint never exposes credentials (0.1988ms)
✔ parseResponseText handles JSON, text and empty responses (0.2065ms)
✔ formatApiError supports string and structured details (0.3357ms)
✔ sanitizeDiagnosticText removes common sensitive values (0.5696ms)
✔ classifyDiagnostic distinguishes authentication, eligibility and rate limits (0.3958ms)
✔ createDiagnosticRecord never includes checkout session identifiers (1.859ms)
✔ validateOfficialActivityUrl accepts only official HTTPS hosts (0.395ms)
✔ response errors receive a dedicated diagnostic category (0.1123ms)
{"timestamp":"2026-08-04T15:31:10.986Z","event":"ready","proxy":"127.0.0.1:0","control":"127.0.0.1:0","firstHop":"127.0.0.1:56668"}
✔ relay recognizes successful CONNECT responses (0.9962ms)
✔ relay diagnostics keep response shape and redact values (1.7905ms)
{"timestamp":"2026-08-04T15:31:10.997Z","event":"configured","phase":"create","previousPhase":null,"endpoint":"http://gateway.example:1000","tunnelsReset":0}
{"timestamp":"2026-08-04T15:31:11.003Z","event":"tunnel_ready","phase":"create","target":"target.example:443","gateway":"http://gateway.example:1000"}
✔ relay performs two CONNECT hops before exposing the tunnel (45.9224ms)
{"timestamp":"2026-08-04T15:31:11.010Z","event":"ready","proxy":"127.0.0.1:0","control":"127.0.0.1:0","firstHop":"127.0.0.1:56675"}
{"timestamp":"2026-08-04T15:31:11.012Z","event":"configured","phase":"create","previousPhase":null,"endpoint":"http://gateway.example:1000","tunnelsReset":0}
{"timestamp":"2026-08-04T15:31:11.016Z","event":"tunnel_ready","phase":"create","target":"create.example:443","gateway":"http://gateway.example:1000"}
{"timestamp":"2026-08-04T15:31:11.018Z","event":"tunnels_reset","reason":"reconfigure","sockets":2}
{"timestamp":"2026-08-04T15:31:11.018Z","event":"configured","phase":"apply","previousPhase":"create","endpoint":"http://gateway.example:1000","tunnelsReset":2}
{"timestamp":"2026-08-04T15:31:11.021Z","event":"tunnel_ready","phase":"apply","target":"apply.example:443","gateway":"http://gateway.example:1000"}
✔ relay destroys existing CONNECT tunnels when switching proxy phases (15.6144ms)
✔ macOS relay scripts install and control the launchd service (0.9265ms)
ℹ tests 44
ℹ suites 0
ℹ pass 44
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 541.2996
```

## Modified
Command: `node --test tests/*.test.cjs`  
Exit: `0`
```text
✔ background applies, reports and clears a phase proxy (12.0638ms)
✔ background acquires official checkout Sentinel headers in the ChatGPT main world (1.1122ms)
✔ background supplies credentials when the proxy challenger uses a resolved host (2.1267ms)
✔ background preflight reports Chrome proxy network errors (53.7538ms)
✔ background preflight accepts any HTTP response reached through the proxy (33.7935ms)
✔ background probes exit IP outside the page CSP and parses Cloudflare trace (1.2626ms)
✔ background routes Chrome through the local Mihomo chain relay when available (1.4611ms)
✔ background initializes a Stripe hosted payment page from a Checkout Session (3.1144ms)
✔ background records only sanitized checkout diagnostics through the local relay (2.1356ms)
✔ content script mounts the two proxy pools and keeps submit disabled initially (9.279ms)
✔ content script manually applies a US proxy from pool 1 to the regular browser profile (13.8062ms)
✔ content script creates a US baseline, applies the promotion through TR, and opens only oaics (78.6783ms)
✔ content script restores and saves proxy pools with chrome.storage.local (325.2774ms)
✔ buildCheckoutPayload returns the expected request body (2.6954ms)
✔ checkout payload builders separate the US baseline from the TR promotion (0.3688ms)
✔ promotion payload accepts the campaign selected from account status (0.3144ms)
✔ PH_SHORT payload contains only the minimal pricing-route fields (0.2808ms)
✔ promotion update payload applies the campaign to an existing OAICS session (1.0402ms)
✔ account promotion context follows account ordering and exposes only safe eligibility fields (1.8517ms)
✔ payment method preflight keeps eligibility and method types without identifiers (0.3393ms)
✔ promotion detection distinguishes the verified PH_SHORT discount from a zero-discount checkout (0.2944ms)
✔ buildCheckoutPayload returns a fresh nested object (0.2655ms)
✔ buildCheckoutUrl validates and encodes the session id (0.3995ms)
✔ resolveHostedCheckoutUrl accepts official processor URLs and rejects unsafe fallbacks (0.5907ms)
✔ checkout session helpers support Stripe init and two safe fallbacks (0.9715ms)
✔ checkout session helpers accept opaque and nested OpenAI session identifiers (0.4411ms)
✔ oaics identifiers are preferred for ChatGPT internal checkout links (2.0018ms)
✔ requireOpenAICheckoutSession rejects Stripe provider responses (0.368ms)
✔ promotion summary preserves eligibility decisions without session identifiers (0.5905ms)
✔ parseProxyLine supports authenticated HTTP and SOCKS proxies (0.4662ms)
✔ parseProxyPool validates line numbers, limits and rotates by cursor (0.4916ms)
✔ formatProxyEndpoint never exposes credentials (0.1542ms)
✔ parseResponseText handles JSON, text and empty responses (0.1575ms)
✔ formatApiError supports string and structured details (0.2452ms)
✔ sanitizeDiagnosticText removes common sensitive values (0.4265ms)
✔ classifyDiagnostic distinguishes authentication, eligibility and rate limits (0.2633ms)
✔ createDiagnosticRecord never includes checkout session identifiers (1.3527ms)
✔ validateOfficialActivityUrl accepts only official HTTPS hosts (0.2734ms)
✔ response errors receive a dedicated diagnostic category (0.0794ms)
{"timestamp":"2026-08-04T15:31:36.182Z","event":"ready","proxy":"127.0.0.1:0","control":"127.0.0.1:0","firstHop":"127.0.0.1:56735"}
✔ relay recognizes successful CONNECT responses (1.4811ms)
✔ relay diagnostics keep response shape and redact values (2.4362ms)
{"timestamp":"2026-08-04T15:31:36.198Z","event":"configured","phase":"create","previousPhase":null,"endpoint":"http://gateway.example:1000","tunnelsReset":0}
{"timestamp":"2026-08-04T15:31:36.205Z","event":"tunnel_ready","phase":"create","target":"target.example:443","gateway":"http://gateway.example:1000"}
✔ relay performs two CONNECT hops before exposing the tunnel (59.5872ms)
{"timestamp":"2026-08-04T15:31:36.215Z","event":"ready","proxy":"127.0.0.1:0","control":"127.0.0.1:0","firstHop":"127.0.0.1:56741"}
{"timestamp":"2026-08-04T15:31:36.217Z","event":"configured","phase":"create","previousPhase":null,"endpoint":"http://gateway.example:1000","tunnelsReset":0}
{"timestamp":"2026-08-04T15:31:36.219Z","event":"tunnel_ready","phase":"create","target":"create.example:443","gateway":"http://gateway.example:1000"}
{"timestamp":"2026-08-04T15:31:36.220Z","event":"tunnels_reset","reason":"reconfigure","sockets":2}
{"timestamp":"2026-08-04T15:31:36.221Z","event":"configured","phase":"apply","previousPhase":"create","endpoint":"http://gateway.example:1000","tunnelsReset":2}
{"timestamp":"2026-08-04T15:31:36.224Z","event":"tunnel_ready","phase":"apply","target":"apply.example:443","gateway":"http://gateway.example:1000"}
✔ relay destroys existing CONNECT tunnels when switching proxy phases (15.8295ms)
✔ macOS relay scripts install and control the launchd service (1.0541ms)
ℹ tests 44
ℹ suites 0
ℹ pass 44
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 561.3825
```

## Package
```text
PACKAGE_VERSION=0.2.4
NEW_LABEL=True
PAGE_RELOAD=False
PACKAGE_ENTRIES=22
PACKAGE_SHA256=1D4A65F944F72EF2D50A9502FE8B2F094DB5B26878D9BAEC10EE53D1E4AD8995
PACKAGE_VERIFY_EXIT=0
```

## Rollback
Command: `powershell.exe -ExecutionPolicy Bypass -File rollback.ps1 -Root <smoke-root>`  
Exit: `0`
```text
RESTORED chatgpt-checkout-helper\content.js
RESTORED chatgpt-checkout-helper\tests\content.test.cjs
RESTORED chatgpt-checkout-helper\manifest.json
RESTORED README.md
RESTORED chatgpt-checkout-helper.zip
ROLLBACK_OK Root=E:\code\plus-extractor\.codex-artifacts\browser-wide-us-label\rollback-smoke-20260804233221
```
