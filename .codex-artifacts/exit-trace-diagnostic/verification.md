# Exit trace diagnostic verification

Generated: 2026-08-04 22:53:17 +08:00

## Baseline 0.2.1

- Command: `node --test tests/*.test.cjs`
- Input: preserved workspace before the CSP fix.
- Exit status: 0
```text
✔ background applies, reports and clears a phase proxy (11.5661ms)
✔ background acquires official checkout Sentinel headers in the ChatGPT main world (1.8828ms)
✔ background supplies credentials when the proxy challenger uses a resolved host (1.8284ms)
✔ background preflight reports Chrome proxy network errors (46.4787ms)
✔ background preflight accepts any HTTP response reached through the proxy (27.6797ms)
✔ background routes Chrome through the local Mihomo chain relay when available (2.8113ms)
✔ background initializes a Stripe hosted payment page from a Checkout Session (2.4836ms)
✔ background records only sanitized checkout diagnostics through the local relay (1.827ms)
✔ content script mounts the two proxy pools and keeps submit disabled initially (10.3739ms)
✔ content script manually applies a US proxy from pool 1 to the current page (9.9746ms)
✔ content script creates a US baseline, applies the promotion through TR, and opens only oaics (75.4725ms)
✔ content script restores and saves proxy pools with chrome.storage.local (324.5432ms)
✔ buildCheckoutPayload returns the expected request body (1.7822ms)
✔ checkout payload builders separate the US baseline from the TR promotion (0.2629ms)
✔ promotion payload accepts the campaign selected from account status (0.2279ms)
✔ PH_SHORT payload contains only the minimal pricing-route fields (0.3368ms)
✔ promotion update payload applies the campaign to an existing OAICS session (0.9647ms)
✔ account promotion context follows account ordering and exposes only safe eligibility fields (1.7749ms)
✔ payment method preflight keeps eligibility and method types without identifiers (0.3163ms)
✔ promotion detection distinguishes the verified PH_SHORT discount from a zero-discount checkout (0.3494ms)
✔ buildCheckoutPayload returns a fresh nested object (0.3019ms)
✔ buildCheckoutUrl validates and encodes the session id (0.446ms)
✔ resolveHostedCheckoutUrl accepts official processor URLs and rejects unsafe fallbacks (0.5492ms)
✔ checkout session helpers support Stripe init and two safe fallbacks (0.99ms)
✔ checkout session helpers accept opaque and nested OpenAI session identifiers (0.861ms)
✔ oaics identifiers are preferred for ChatGPT internal checkout links (0.4739ms)
✔ requireOpenAICheckoutSession rejects Stripe provider responses (0.218ms)
✔ promotion summary preserves eligibility decisions without session identifiers (0.5303ms)
✔ parseProxyLine supports authenticated HTTP and SOCKS proxies (0.3791ms)
✔ parseProxyPool validates line numbers, limits and rotates by cursor (0.4623ms)
✔ formatProxyEndpoint never exposes credentials (0.1435ms)
✔ parseResponseText handles JSON, text and empty responses (0.1527ms)
✔ formatApiError supports string and structured details (0.2413ms)
✔ sanitizeDiagnosticText removes common sensitive values (0.4103ms)
✔ classifyDiagnostic distinguishes authentication, eligibility and rate limits (0.2621ms)
✔ createDiagnosticRecord never includes checkout session identifiers (1.4105ms)
✔ validateOfficialActivityUrl accepts only official HTTPS hosts (0.5033ms)
✔ response errors receive a dedicated diagnostic category (0.1439ms)
{"timestamp":"2026-08-04T14:49:16.443Z","event":"ready","proxy":"127.0.0.1:0","control":"127.0.0.1:0","firstHop":"127.0.0.1:65072"}
✔ relay recognizes successful CONNECT responses (1.5662ms)
✔ relay diagnostics keep response shape and redact values (2.5042ms)
{"timestamp":"2026-08-04T14:49:16.456Z","event":"configured","phase":"create","previousPhase":null,"endpoint":"http://gateway.example:1000","tunnelsReset":0}
{"timestamp":"2026-08-04T14:49:16.461Z","event":"tunnel_ready","phase":"create","target":"target.example:443","gateway":"http://gateway.example:1000"}
✔ relay performs two CONNECT hops before exposing the tunnel (49.2919ms)
{"timestamp":"2026-08-04T14:49:16.470Z","event":"ready","proxy":"127.0.0.1:0","control":"127.0.0.1:0","firstHop":"127.0.0.1:65078"}
{"timestamp":"2026-08-04T14:49:16.473Z","event":"configured","phase":"create","previousPhase":null,"endpoint":"http://gateway.example:1000","tunnelsReset":0}
{"timestamp":"2026-08-04T14:49:16.475Z","event":"tunnel_ready","phase":"create","target":"create.example:443","gateway":"http://gateway.example:1000"}
{"timestamp":"2026-08-04T14:49:16.476Z","event":"tunnels_reset","reason":"reconfigure","sockets":2}
{"timestamp":"2026-08-04T14:49:16.477Z","event":"configured","phase":"apply","previousPhase":"create","endpoint":"http://gateway.example:1000","tunnelsReset":2}
{"timestamp":"2026-08-04T14:49:16.479Z","event":"tunnel_ready","phase":"apply","target":"apply.example:443","gateway":"http://gateway.example:1000"}
✔ relay destroys existing CONNECT tunnels when switching proxy phases (16.0369ms)
✔ macOS relay scripts install and control the launchd service (1.283ms)
ℹ tests 43
ℹ suites 0
ℹ pass 43
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 537.3521
```

## Modified 0.2.2

- Command: `node --test tests/*.test.cjs`
- Input: background exit probes plus UI IP comparison.
- Exit status: 0
```text
✔ background applies, reports and clears a phase proxy (9.5517ms)
✔ background acquires official checkout Sentinel headers in the ChatGPT main world (1.174ms)
✔ background supplies credentials when the proxy challenger uses a resolved host (1.2437ms)
✔ background preflight reports Chrome proxy network errors (49.7862ms)
✔ background preflight accepts any HTTP response reached through the proxy (30.4853ms)
✔ background probes exit IP outside the page CSP and parses Cloudflare trace (1.8019ms)
✔ background routes Chrome through the local Mihomo chain relay when available (1.6635ms)
✔ background initializes a Stripe hosted payment page from a Checkout Session (2.3736ms)
✔ background records only sanitized checkout diagnostics through the local relay (1.7068ms)
✔ content script mounts the two proxy pools and keeps submit disabled initially (8.8067ms)
✔ content script manually applies a US proxy from pool 1 to the current page (10.2334ms)
✔ content script creates a US baseline, applies the promotion through TR, and opens only oaics (66.8164ms)
✔ content script restores and saves proxy pools with chrome.storage.local (335.9453ms)
✔ buildCheckoutPayload returns the expected request body (1.9184ms)
✔ checkout payload builders separate the US baseline from the TR promotion (0.2796ms)
✔ promotion payload accepts the campaign selected from account status (0.2337ms)
✔ PH_SHORT payload contains only the minimal pricing-route fields (0.234ms)
✔ promotion update payload applies the campaign to an existing OAICS session (0.6402ms)
✔ account promotion context follows account ordering and exposes only safe eligibility fields (1.2729ms)
✔ payment method preflight keeps eligibility and method types without identifiers (0.2617ms)
✔ promotion detection distinguishes the verified PH_SHORT discount from a zero-discount checkout (0.2214ms)
✔ buildCheckoutPayload returns a fresh nested object (0.2874ms)
✔ buildCheckoutUrl validates and encodes the session id (0.3751ms)
✔ resolveHostedCheckoutUrl accepts official processor URLs and rejects unsafe fallbacks (0.638ms)
✔ checkout session helpers support Stripe init and two safe fallbacks (1.452ms)
✔ checkout session helpers accept opaque and nested OpenAI session identifiers (0.5848ms)
✔ oaics identifiers are preferred for ChatGPT internal checkout links (0.5338ms)
✔ requireOpenAICheckoutSession rejects Stripe provider responses (0.3102ms)
✔ promotion summary preserves eligibility decisions without session identifiers (0.7569ms)
✔ parseProxyLine supports authenticated HTTP and SOCKS proxies (0.5498ms)
✔ parseProxyPool validates line numbers, limits and rotates by cursor (0.6549ms)
✔ formatProxyEndpoint never exposes credentials (0.2163ms)
✔ parseResponseText handles JSON, text and empty responses (0.2151ms)
✔ formatApiError supports string and structured details (0.3408ms)
✔ sanitizeDiagnosticText removes common sensitive values (0.6006ms)
✔ classifyDiagnostic distinguishes authentication, eligibility and rate limits (0.396ms)
✔ createDiagnosticRecord never includes checkout session identifiers (1.6489ms)
✔ validateOfficialActivityUrl accepts only official HTTPS hosts (0.287ms)
✔ response errors receive a dedicated diagnostic category (0.0791ms)
{"timestamp":"2026-08-04T14:52:13.439Z","event":"ready","proxy":"127.0.0.1:0","control":"127.0.0.1:0","firstHop":"127.0.0.1:49497"}
✔ relay recognizes successful CONNECT responses (1.4768ms)
✔ relay diagnostics keep response shape and redact values (2.3531ms)
{"timestamp":"2026-08-04T14:52:13.453Z","event":"configured","phase":"create","previousPhase":null,"endpoint":"http://gateway.example:1000","tunnelsReset":0}
{"timestamp":"2026-08-04T14:52:13.459Z","event":"tunnel_ready","phase":"create","target":"target.example:443","gateway":"http://gateway.example:1000"}
✔ relay performs two CONNECT hops before exposing the tunnel (48.9832ms)
{"timestamp":"2026-08-04T14:52:13.466Z","event":"ready","proxy":"127.0.0.1:0","control":"127.0.0.1:0","firstHop":"127.0.0.1:49503"}
{"timestamp":"2026-08-04T14:52:13.468Z","event":"configured","phase":"create","previousPhase":null,"endpoint":"http://gateway.example:1000","tunnelsReset":0}
{"timestamp":"2026-08-04T14:52:13.470Z","event":"tunnel_ready","phase":"create","target":"create.example:443","gateway":"http://gateway.example:1000"}
{"timestamp":"2026-08-04T14:52:13.471Z","event":"tunnels_reset","reason":"reconfigure","sockets":2}
{"timestamp":"2026-08-04T14:52:13.472Z","event":"configured","phase":"apply","previousPhase":"create","endpoint":"http://gateway.example:1000","tunnelsReset":2}
{"timestamp":"2026-08-04T14:52:13.476Z","event":"tunnel_ready","phase":"apply","target":"apply.example:443","gateway":"http://gateway.example:1000"}
✔ relay destroys existing CONNECT tunnels when switching proxy phases (16.4545ms)
✔ macOS relay scripts install and control the launchd service (1.4037ms)
ℹ tests 44
ℹ suites 0
ℹ pass 44
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 529.9562
```

## Package

- Command: open ZIP; parse manifest; inspect packaged background/content scripts.
- Exit status: 0
```text
PACKAGE_VERSION=0.2.2
BACKGROUND_TRACE_HANDLER=True
CONTENT_IP_COMPARISON=True
PACKAGE_ENTRIES=22
PACKAGE_SHA256=6C51377F8E20C223C02FEC1F9E3D46B0CBD08E60E98B6496599868492A7DF0EB
PACKAGE_VERIFY_EXIT=0
```

## Rollback

- Command: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File rollback.ps1 -Root <smoke-root>`
- Input: copy of modified 0.2.2 workspace.
- Exit status: 0
```text
RESTORED chatgpt-checkout-helper\background.js SHA256=98D9BE206D6A72A7F3377CF6457FD45B1A167AB9F6C12008A658CD69C9E0663F
RESTORED chatgpt-checkout-helper\content.js SHA256=97C95912271B00A5D49A259A99313DFE3A70FC6F99C52AA7C7E1A085BFF543E7
RESTORED chatgpt-checkout-helper\tests\background.test.cjs SHA256=50AF62D713176CFC35606006140F472A9472CA4C9C59C38280FB90DE42713DBE
RESTORED chatgpt-checkout-helper\tests\content.test.cjs SHA256=2E125938E732A4C37667758D39A0CE32379EC6C988A633120D716B40EA507299
RESTORED chatgpt-checkout-helper\manifest.json SHA256=99DC56BB503626EA76D3A47256BD5025C783D7D6E069B1F490F29ADFC2F11B51
RESTORED README.md SHA256=045D8A40331E80A2F0428D98AA0060AFC3703183BFBB8FFCE41F53CE4DF5BD04
RESTORED chatgpt-checkout-helper.zip SHA256=0BA90ADC5DE1170A37EAA253C9AA72A7F724C5C36E3AFE9AEDF63242951E1F62
ROLLBACK_OK Root=E:\code\plus-extractor\.codex-artifacts\exit-trace-diagnostic\rollback-smoke-20260804225227
```

- Rolled-back version: 0.2.1
- Rolled-back test result: 43 passed, 0 failed.

## Diff check

- Command: `git diff --check`
- Exit status: 0
```text
warning: in the working copy of 'README.md', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'chatgpt-checkout-helper/background.js', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'chatgpt-checkout-helper/content.js', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'chatgpt-checkout-helper/manifest.json', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'chatgpt-checkout-helper/tests/background.test.cjs', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'chatgpt-checkout-helper/tests/content.test.cjs', LF will be replaced by CRLF the next time Git touches it
DIFF_CHECK_EXIT=0
```
