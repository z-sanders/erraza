# Verification record

Checked on 2026-11-05 against the local working tree. This is an engineering test record, not payment-provider certification or a guarantee of production readiness.

## Completed locally

- `npm run build`: generated 17 local Phosphor icons plus font/icon licenses, with no build-time external asset requests.
- `npm run check`: JavaScript syntax, expected Vercel settings, local/deployed security-header parity and built public assets.
- `npm test`: 96 automated tests passed; the opt-in real Redis integration test is separately skipped without its dedicated test credentials.
- `npm audit --omit=dev`: no known vulnerabilities reported in the pinned runtime dependencies at the time of checking.
- Handler fixtures cover exact decimal validation, documented endpoint/query names, raw and Vercel-parsed bodies, split UTF-8 input, CSRF/origin checks, signature tampering, merchant network selection, concurrent duplicate requests, early callbacks, uncertain creation, fiat type/amount gating, delayed stable receipt tokens, underpayment/finality, manual reconciliation and static path containment.
- Rendered the real unconfigured application at 1280px desktop and 390px mobile widths. Inspected light/dark themes. No mobile horizontal overflow observed.
- Exercised the coin selector, quote, native crypto dialog and status polling against **test-only** provider/store fixtures. Verified exact network display, destination tag `0`, address-only QR instructions, and the absence of simulated settlement in normal application code.
- Automated axe-core WCAG 2 A/AA and 2.1 AA browser scans returned zero violations for the mobile form (24 passing checks) and payment dialog (21 passing checks). These scans do not replace manual accessibility testing.

## Preset links and payer help

- Verified `/create-link.html` rendering at 1280px desktop and 390px mobile; mobile page width matched the viewport without horizontal overflow.
- Browser event-handler checks generated a `$125.50 USD` URL and navigation to that exact URL displayed `125.50` in the editable checkout amount with USD and fiat/card selected. No payment was created.
- Node tests cover USD/EUR/JPY precision, invalid/duplicate presets, bounds, same-site link construction, missing-config retry, payer edits, existing-payment/recovery precedence, copied/stale links and clipboard failure fallback.
- Help is now payer-focused, and Privacy uses its own native dialog and focus target. Static/dialog-handler tests verify the separation. Native browser input/clipboard limitations below still apply; no live clipboard success or keyboard acceptance was claimed.

## Mobile refinement, PWA and personalization

- Verified a personalized checkout at 320px: amount and reference render separately from the configured merchant. After correcting the old minimum document width, document scroll width matched its client width (305px, with the desktop scrollbar occupying the remainder of the 320px viewport).
- Measured the mobile currency control at 48px tall with 16px text and quick-amount controls at 44px tall.
- Confirmed an active `/sw.js` registration in the browser. Inspected Cache Storage: exactly the generic offline HTML/CSS/JS and four installation icons were stored; no checkout, API, personalized URL or receipt entries were present.
- Tests cover PWA manifest/icon dimensions, cache exclusions, conservative updates, install prompt behavior, optional reference validation/persistence, unchanged payout destination, decimal-comma handling, copy-first QR order and refreshing unresolved payments after a long absence.
- Real iOS/Android installation, virtual-keyboard behavior and provider-app return flows remain unverified. The browser checks establish local rendering and registration, not complete device acceptance. Offline fallback behavior was tested with isolated service-worker fixtures, not by disabling the host network.

## Browser tooling limitation

The in-app browser rendered and evaluated page scripts, but native click/keyboard delivery repeatedly timed out or had no effect despite unobstructed enabled controls. Event-handler tests used element activation through the browser evaluation API after observing the elements. Thus native pointer, keyboard, clipboard permission and end-to-end user-interaction acceptance remain unverified. Full-page screenshots also tiled incorrectly in the browser tool; viewport screenshots were used for visual checks.

## Not completed / launch gates

- No Vercel deployment or Vercel-hosted browser test was performed.
- No live or NOWPayments-sandbox payment was created. All automated provider responses were isolated test fixtures.
- Real Redis Lua/CAS/TTL behavior was not executed: no Redis credentials or running local Docker daemon were available. Use a **dedicated test database**, set `TEST_REDIS_REST_URL` and `TEST_REDIS_REST_TOKEN`, then run `npm test` to enable `test/redis.integration.test.js`. It writes a unique namespace with two-minute TTLs. Never point it at production credentials.
- Merchant fiat activation/KYC is reported complete by the user. Account-specific fiat response denominations, customer KYC/3DS and fiat settlement still need live verification. The provider host list is now an optional restriction; verified server-returned HTTPS links work without it. Unrecognized/unverified shapes fail closed.
- Provider-issued signature fixtures containing arrays need confirmation because the official Node/Python canonicalization examples differ. Local signature tests are not proof that every vendor payload interoperates.
- Wallet scan/transfer and actual memo/network compatibility remain unverified.
- Lighthouse/Core Web Vitals measurements were not run.
- Erraza is provisional: no domain/business-name/trademark clearance was obtained.

The normal application intentionally refuses payment creation until required backend settings are present. Consult `README.md` and `.env.example` for the complete setup. No deployment, domain registration or real-money movement occurred in this session.
