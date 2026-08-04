# US proxy button verification record

Generated: 2026-08-04 22:40:49 +08:00

## Baseline behavior

- Command: `& 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test tests/*.test.cjs`
- Input: rollback-smoke copy restored from the preserved 0.2.0 files.
- Exit status: 0
- Literal output:
```text
✔ background applies, reports and clears a phase proxy (34.3063ms)
✔ background acquires official checkout Sentinel headers in the ChatGPT main world (2.8543ms)
✔ background supplies credentials when the proxy challenger uses a resolved host (2.6244ms)
✔ background preflight reports Chrome proxy network errors (49.3149ms)
✔ background preflight accepts any HTTP response reached through the proxy (34.1095ms)
✔ background routes Chrome through the local Mihomo chain relay when available (2.3471ms)
✔ background initializes a Stripe hosted payment page from a Checkout Session (2.7529ms)
✔ background records only sanitized checkout diagnostics through the local relay (1.6599ms)
✔ content script mounts the two proxy pools and keeps submit disabled initially (11.3909ms)
✔ content script creates a US baseline, applies the promotion through TR, and opens only oaics (79.6253ms)
✔ content script restores and saves proxy pools with chrome.storage.local (336.3811ms)
✔ buildCheckoutPayload returns the expected request body (4.3784ms)
✔ checkout payload builders separate the US baseline from the TR promotion (0.3159ms)
✔ promotion payload accepts the campaign selected from account status (0.2542ms)
✔ PH_SHORT payload contains only the minimal pricing-route fields (0.2596ms)
✔ promotion update payload applies the campaign to an existing OAICS session (0.739ms)
✔ account promotion context follows account ordering and exposes only safe eligibility fields (2.2796ms)
✔ payment method preflight keeps eligibility and method types without identifiers (0.4294ms)
✔ promotion detection distinguishes the verified PH_SHORT discount from a zero-discount checkout (0.3348ms)
✔ buildCheckoutPayload returns a fresh nested object (0.2857ms)
✔ buildCheckoutUrl validates and encodes the session id (0.4191ms)
✔ resolveHostedCheckoutUrl accepts official processor URLs and rejects unsafe fallbacks (0.768ms)
✔ checkout session helpers support Stripe init and two safe fallbacks (2.0417ms)
✔ checkout session helpers accept opaque and nested OpenAI session identifiers (0.503ms)
✔ oaics identifiers are preferred for ChatGPT internal checkout links (0.4208ms)
✔ requireOpenAICheckoutSession rejects Stripe provider responses (0.2536ms)
✔ promotion summary preserves eligibility decisions without session identifiers (0.568ms)
✔ parseProxyLine supports authenticated HTTP and SOCKS proxies (0.7917ms)
✔ parseProxyPool validates line numbers, limits and rotates by cursor (0.7119ms)
✔ formatProxyEndpoint never exposes credentials (0.2361ms)
✔ parseResponseText handles JSON, text and empty responses (0.2354ms)
✔ formatApiError supports string and structured details (0.3872ms)
✔ sanitizeDiagnosticText removes common sensitive values (0.6528ms)
✔ classifyDiagnostic distinguishes authentication, eligibility and rate limits (0.4205ms)
✔ createDiagnosticRecord never includes checkout session identifiers (1.842ms)
✔ validateOfficialActivityUrl accepts only official HTTPS hosts (0.3812ms)
✔ response errors receive a dedicated diagnostic category (0.1113ms)
{"timestamp":"2026-08-04T14:40:30.686Z","event":"ready","proxy":"127.0.0.1:0","control":"127.0.0.1:0","firstHop":"127.0.0.1:64098"}
✔ relay recognizes successful CONNECT responses (1.863ms)
✔ relay diagnostics keep response shape and redact values (2.0632ms)
{"timestamp":"2026-08-04T14:40:30.704Z","event":"configured","phase":"create","previousPhase":null,"endpoint":"http://gateway.example:1000","tunnelsReset":0}
{"timestamp":"2026-08-04T14:40:30.709Z","event":"tunnel_ready","phase":"create","target":"target.example:443","gateway":"http://gateway.example:1000"}
✔ relay performs two CONNECT hops before exposing the tunnel (59.838ms)
{"timestamp":"2026-08-04T14:40:30.718Z","event":"ready","proxy":"127.0.0.1:0","control":"127.0.0.1:0","firstHop":"127.0.0.1:64104"}
{"timestamp":"2026-08-04T14:40:30.721Z","event":"configured","phase":"create","previousPhase":null,"endpoint":"http://gateway.example:1000","tunnelsReset":0}
{"timestamp":"2026-08-04T14:40:30.723Z","event":"tunnel_ready","phase":"create","target":"create.example:443","gateway":"http://gateway.example:1000"}
{"timestamp":"2026-08-04T14:40:30.724Z","event":"tunnels_reset","reason":"reconfigure","sockets":2}
{"timestamp":"2026-08-04T14:40:30.724Z","event":"configured","phase":"apply","previousPhase":"create","endpoint":"http://gateway.example:1000","tunnelsReset":2}
{"timestamp":"2026-08-04T14:40:30.727Z","event":"tunnel_ready","phase":"apply","target":"apply.example:443","gateway":"http://gateway.example:1000"}
✔ relay destroys existing CONNECT tunnels when switching proxy phases (16.2969ms)
✔ macOS relay scripts install and control the launchd service (1.3427ms)
ℹ tests 42
ℹ suites 0
ℹ pass 42
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 582.3293
```

## Modified behavior

- Command: `& 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test tests/*.test.cjs`
- Input: version 0.2.1 workspace with the manual US proxy button.
- Exit status: 0
- Literal output:
```text
✔ background applies, reports and clears a phase proxy (10.4896ms)
✔ background acquires official checkout Sentinel headers in the ChatGPT main world (1.2662ms)
✔ background supplies credentials when the proxy challenger uses a resolved host (1.7737ms)
✔ background preflight reports Chrome proxy network errors (44.3218ms)
✔ background preflight accepts any HTTP response reached through the proxy (33.6482ms)
✔ background routes Chrome through the local Mihomo chain relay when available (2.406ms)
✔ background initializes a Stripe hosted payment page from a Checkout Session (2.8723ms)
✔ background records only sanitized checkout diagnostics through the local relay (1.5216ms)
✔ content script mounts the two proxy pools and keeps submit disabled initially (7.39ms)
✔ content script manually applies a US proxy from pool 1 to the current page (10.6691ms)
✔ content script creates a US baseline, applies the promotion through TR, and opens only oaics (71.507ms)
✔ content script restores and saves proxy pools with chrome.storage.local (336.1981ms)
✔ buildCheckoutPayload returns the expected request body (1.7411ms)
✔ checkout payload builders separate the US baseline from the TR promotion (0.2758ms)
✔ promotion payload accepts the campaign selected from account status (0.2245ms)
✔ PH_SHORT payload contains only the minimal pricing-route fields (0.198ms)
✔ promotion update payload applies the campaign to an existing OAICS session (0.6126ms)
✔ account promotion context follows account ordering and exposes only safe eligibility fields (1.093ms)
✔ payment method preflight keeps eligibility and method types without identifiers (0.2148ms)
✔ promotion detection distinguishes the verified PH_SHORT discount from a zero-discount checkout (0.1878ms)
✔ buildCheckoutPayload returns a fresh nested object (0.1797ms)
✔ buildCheckoutUrl validates and encodes the session id (0.2664ms)
✔ resolveHostedCheckoutUrl accepts official processor URLs and rejects unsafe fallbacks (0.5114ms)
✔ checkout session helpers support Stripe init and two safe fallbacks (0.9284ms)
✔ checkout session helpers accept opaque and nested OpenAI session identifiers (0.4685ms)
✔ oaics identifiers are preferred for ChatGPT internal checkout links (0.4078ms)
✔ requireOpenAICheckoutSession rejects Stripe provider responses (0.2094ms)
✔ promotion summary preserves eligibility decisions without session identifiers (0.69ms)
✔ parseProxyLine supports authenticated HTTP and SOCKS proxies (0.5639ms)
✔ parseProxyPool validates line numbers, limits and rotates by cursor (0.6465ms)
✔ formatProxyEndpoint never exposes credentials (0.2032ms)
✔ parseResponseText handles JSON, text and empty responses (0.2323ms)
✔ formatApiError supports string and structured details (0.3447ms)
✔ sanitizeDiagnosticText removes common sensitive values (0.5835ms)
✔ classifyDiagnostic distinguishes authentication, eligibility and rate limits (0.3011ms)
✔ createDiagnosticRecord never includes checkout session identifiers (1.3959ms)
✔ validateOfficialActivityUrl accepts only official HTTPS hosts (0.3891ms)
✔ response errors receive a dedicated diagnostic category (0.1107ms)
{"timestamp":"2026-08-04T14:39:08.815Z","event":"ready","proxy":"127.0.0.1:0","control":"127.0.0.1:0","firstHop":"127.0.0.1:63936"}
✔ relay recognizes successful CONNECT responses (0.9817ms)
✔ relay diagnostics keep response shape and redact values (2.4849ms)
{"timestamp":"2026-08-04T14:39:08.831Z","event":"configured","phase":"create","previousPhase":null,"endpoint":"http://gateway.example:1000","tunnelsReset":0}
{"timestamp":"2026-08-04T14:39:08.839Z","event":"tunnel_ready","phase":"create","target":"target.example:443","gateway":"http://gateway.example:1000"}
✔ relay performs two CONNECT hops before exposing the tunnel (58.1627ms)
{"timestamp":"2026-08-04T14:39:08.848Z","event":"ready","proxy":"127.0.0.1:0","control":"127.0.0.1:0","firstHop":"127.0.0.1:63942"}
{"timestamp":"2026-08-04T14:39:08.850Z","event":"configured","phase":"create","previousPhase":null,"endpoint":"http://gateway.example:1000","tunnelsReset":0}
{"timestamp":"2026-08-04T14:39:08.852Z","event":"tunnel_ready","phase":"create","target":"create.example:443","gateway":"http://gateway.example:1000"}
{"timestamp":"2026-08-04T14:39:08.854Z","event":"tunnels_reset","reason":"reconfigure","sockets":2}
{"timestamp":"2026-08-04T14:39:08.854Z","event":"configured","phase":"apply","previousPhase":"create","endpoint":"http://gateway.example:1000","tunnelsReset":2}
{"timestamp":"2026-08-04T14:39:08.857Z","event":"tunnel_ready","phase":"apply","target":"apply.example:443","gateway":"http://gateway.example:1000"}
✔ relay destroys existing CONNECT tunnels when switching proxy phases (14.8326ms)
✔ macOS relay scripts install and control the launchd service (1.0486ms)
ℹ tests 43
ℹ suites 0
ℹ pass 43
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 545.3132
```

## Package verification

- Command: open `chatgpt-checkout-helper.zip`, parse `manifest.json`, and search packaged `content.js` for the button label.
- Input: packaged extension archive.
- Exit status: 0
- Literal output:
```text
PACKAGE_VERSION=0.2.1
PACKAGE_BUTTON_PRESENT=True
PACKAGE_ENTRIES=22
PACKAGE_SHA256=0BA90ADC5DE1170A37EAA253C9AA72A7F724C5C36E3AFE9AEDF63242951E1F62
PACKAGE_VERIFY_EXIT=0
```

## Rollback verification

- Command: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'E:\code\plus-extractor\.codex-artifacts\us-proxy-button\rollback.ps1' -Root <rollback-smoke-root>`
- Input: copy of the modified workspace.
- Exit status: 0
- Literal output:
```text
RESTORED chatgpt-checkout-helper\content.js SHA256=A1371215EE6B4B9F7831666EE0E828D64D1287949E380CE4ADE2A4B68F59372F
RESTORED chatgpt-checkout-helper\tests\content.test.cjs SHA256=14282CA8833EF6E7EBD617CA56B5409271D57A5E9A7B9151588B1040FAA19D8B
RESTORED chatgpt-checkout-helper\manifest.json SHA256=04683CABBA98C407504CAB814477C14FE01A30D43013B994707F4276B334598A
RESTORED README.md SHA256=0F4CF7CE976E83FEBFFBA55C538F5CA70BC82EA6113D83083FA20EC10881E2D6
RESTORED chatgpt-checkout-helper.zip SHA256=994A12E4B8C5279EA74697B909C654E3D1FB00666B95147F4BB9946FDE5DBE1F
ROLLBACK_OK Root=E:\code\plus-extractor\.codex-artifacts\us-proxy-button\rollback-smoke-20260804223838
```

## Diff check

- Command: `git diff --check`
- Input: modified workspace.
- Exit status: 0
- Literal output:
```text
DIFF_CHECK_OUTPUT_BEGIN
warning: in the working copy of 'README.md', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'chatgpt-checkout-helper/content.js', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'chatgpt-checkout-helper/manifest.json', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'chatgpt-checkout-helper/tests/content.test.cjs', LF will be replaced by CRLF the next time Git touches it
DIFF_CHECK_OUTPUT_END
DIFF_CHECK_EXIT=0
```
