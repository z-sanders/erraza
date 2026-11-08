# Erraza checkout

Custom-amount checkout using a static frontend, Node.js 24 CommonJS API functions, NOWPayments, and persistent Supabase storage.

**Erraza is a provisional working name. It has not been cleared for domain availability, business-name use, or trademarks.** Set the merchant's actual approved branding and support contact before launch. This repository does not supply a legal identity, merchant policies, or invented legal pages.

## What this app does

- **Crypto stays inline:** the app's own dialog displays the provider-issued payment address, amount, network, destination tag/memo when required, and a QR code. This is not a provider iframe. The QR encodes the address; confirm the amount, asset/network, and any required memo separately before sending.
- **Fiat uses a hosted fallback:** the merchant has confirmed on-ramp activation, so fiat is enabled by default. The app uses only the HTTPS checkout link returned in a validated NOWPayments `fiat2crypto` response. A separate provider-host allowlist is optional, not an activation requirement. No iframe or guessed invoice fallback is used.
- **Real backend only:** missing credentials or storage disable payments. There are no simulated payments, invented rates, or timed success states in the normal application. Provider doubles and fixture data belong only in tests.
- **Server-verified settlement:** a return URL or browser state is not proof of payment. Only `finished` with matching stored identity and verified amounts is paid; `confirmed` and `sending` are not final settlement.
- **Supabase-backed orders:** payment attempts, idempotency, updates, and rate limits are shared between serverless instances. No local order file is used.

See [the provider contract and its limitations](docs/nowpayments.md) before enabling live payments. [Local verification results and unperformed launch checks](docs/verification.md) distinguish tested behavior from provider/account assumptions.

## Requirements and configuration

Use **Node.js 24.x** and install the locked dependencies with `npm ci`. The build needs dev dependencies because it copies assets from the pinned `@phosphor-icons/core` package. Do not configure the build install step to omit dev dependencies.

Copy `.env.example` to `.env` for local development; populate production values in Vercel's Environment Variables instead. Never put credentials in `public/`, client bundles, or version control.

| Variable | Purpose |
| --- | --- |
| `NOWPAYMENTS_API_KEY` | Required matching live or sandbox API credential. |
| `NOWPAYMENTS_IPN_SECRET` | Required webhook signing secret from the same account/environment. |
| `CHECKOUT_SECRET` | Required independent random secret, at least 32 characters; protects checkout/session references. |
| `PUBLIC_BASE_URL` | Required exact origin. Production requires HTTPS, with no path/query/fragment or credentials. Browser and callback origin must match. |
| `SUPABASE_URL` | Required Supabase project API URL used by the server runtime. |
| `SUPABASE_SERVICE_ROLE_KEY` | Required server-only Supabase service-role key. Configure it only in local/server or Vercel runtime secrets; never expose it to browser code or a public environment variable. |
| `NOWPAYMENTS_PAYOUT_CURRENCY` | Required payout ticker used as the minimum API's `currency_to`. Use the NOWPayments dashboard default unless a different provider contract for this account is separately confirmed. |
| `NOWPAYMENTS_SANDBOX` | Required and must be exactly `true` or `false`; missing or any other value keeps checkout unconfigured. `true` selects the separate sandbox API/account, while `false` selects live. Production payments require `false` and live credentials. |
| `BRAND_NAME` | Optional, defaults to provisional `Erraza`. |
| `SUPPORT_EMAIL` | Optional real merchant support address. Leave blank rather than inventing one. |
| `MIN_PAYMENT_AMOUNT`, `MAX_PAYMENT_AMOUNT` | Defaults `1` and `100000`, in the selected pricing currency. These are not FX-normalized limits; provider minimums may be higher. |
| `NOWPAYMENTS_FIAT_ENABLED` | Optional override, defaults to `true` for this already-activated merchant account. Set `false` only to intentionally turn card payments off. This setting is not an account-approval check. |
| `NOWPAYMENTS_FIAT_REDIRECT_HOSTS` | Optional additional restriction on provider-returned checkout URLs. Leave blank for normal operation, or specify exact comma-separated hosts. Malformed restrictions disable fiat rather than silently dropping restrictions. |
| `RECONCILIATION_SECRET` | Optional separate random secret of at least 32 characters for the merchant-only manual reconciliation endpoint. Empty disables that endpoint. Never expose it to browsers. |
| `PORT` | Local loopback server port, default `3000`. |

Generate separate signing/operator secrets locally, for example:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Keep sandbox/preview and live resources separate. Changing the public origin or signing secrets can invalidate existing sessions/receipt references and change the storage namespace; coordinate such changes with open orders. Supabase is an operational payment store, not a substitute for merchant accounting records or a backup policy.

### Supabase migration order

Apply `supabase-migration.sql` to each target Supabase database **before** deploying or starting application code that uses it. Migration first, runtime configuration second, code deployment last: this prevents the deployed handlers from reaching a database whose required schema is absent.

The application runtime needs only `SUPABASE_URL` and the server-only `SUPABASE_SERVICE_ROLE_KEY`. A direct Postgres database connection string/password may be used by an administrator or migration tool to apply the SQL migration, but it is not an application or Vercel runtime environment variable and must not be exposed to the frontend. You may instead apply the migration through the Supabase SQL editor. Keep migration credentials out of `.env.example`, browser code, and deployment output.

### Fiat activation

The direct API integration supports these pricing currencies: **USD, EUR, ILS, GBP, AUD, RON**. API availability, provider onboarding, merchant KYB, customer KYC, regions, limits, fees, and offered payment methods depend on the account and on-ramp provider. This does not guarantee card acceptance for every customer or every card brand.

The merchant has already completed NOWPayments' fiat activation/KYC. No repeat onboarding or second app-side approval is required. Add the remaining credentials and deployment values, then restart/redeploy. The app accepts the checkout link only from a verified server-side NOWPayments response, requires HTTPS without credentials or an unexpected port, and rejects IP-literal/local destinations. An optional exact-host allowlist can impose tighter restrictions. Client-supplied checkout URLs are never accepted, and creating a payment remains subject to NOWPayments' actual account/currency eligibility.

## Preset payment links

Open **`/create-link.html`** on your checkout website (locally: `http://localhost:3000/create-link.html`). Enter an amount and currency, optionally add a **For** name/reference, choose **Create link**, then **Copy link**. **Preview checkout** opens the payer page in a new tab.

A link looks like `https://your-checkout.example/?amount=125.00&currency=usd`. It prefills an **editable** amount and currency; fiat/card stays selected by default. The link does not lock an amount, act as an invoice, change the merchant or wallet, or create a payment. The payer must continue through checkout before anything is created with NOWPayments.

Generate shareable links from your deployed domain; localhost links only work on your own computer. Anyone can assemble a prefill URL, so it is intentionally not a trusted invoice or an authorization mechanism. Normal server-side validation and provider minimums still apply. Invalid presets leave the amount blank with an error. A saved or unresolved payment takes precedence and is never overwritten by link parameters.

The creator is a separate, noindex utility page, not an authenticated admin console. It exposes no credentials or payment records. Its settings come from the same public checkout configuration. You can prepare links before payment credentials are configured, but finish configuration and verify checkout before sharing them.

Optional personalization adds `&for=Mina` to the URL. The payer form uses **Payment for [name/reference]** as its heading without repeating the merchant name already visible in the header; the merchant identity remains in the receipt. The Continue button shows the current amount and currency, without implying that pressing it immediately charges the payer. The reference is display/order metadata, not a verified recipient identity or a payout instruction. It is limited to 80 characters, cannot contain markup or hidden direction-control characters, is validated again on the server, and becomes part of the order's idempotency fingerprint. Existing links and pending requests without a reference remain supported. Avoid sensitive information: links can be forwarded and appear in browser history or hosting request logs.

Payment help contains payer-focused guidance. Privacy information is available through the separate **Privacy** dialog.

## Mobile and PWA

The checkout uses larger mobile touch targets, 16px focusable fields, safe-area spacing and visual-viewport dialog sizing. Crypto amount, address and required memo are presented before the optional QR. An unresolved payment is refreshed when the page returns to the foreground, even after the prior polling window expired. Decimal-comma input such as `125,50` is normalized to `125.50`; ambiguous thousands grouping remains invalid.

The app includes `manifest.webmanifest`, standalone launch, 192/512px and maskable icons, an Apple touch icon, and `/sw.js`. On supported browsers an optional **Add to home screen** action appears; iOS guidance uses the Share menu. Browser policies determine installation availability. Production installation requires HTTPS. The manifest currently uses the Erraza name/icons; changing runtime `BRAND_NAME` does not rewrite already installed app branding, so update the manifest/icons before a rebrand.

Payments remain **online-only**. The service worker caches only `/offline.html`, `/offline.css`, `/offline.js` and fixed install icons. It never stores API responses, checkout pages, personalized URLs, receipts or payment addresses, and never queues/replays a payment. Navigation failures show a generic reconnect page without implying a payment failed. Checkout documents and API responses use `no-store`; worker updates wait rather than interrupt an active payment. Closing all tabs/app windows lets a waiting worker activate. No background sync or push notifications are used.

The icon PNGs are committed public assets; `scripts/pwa-assets.js` can regenerate them using the installed `pngjs` dependency. Bump the worker cache version when offline assets change. Test installation, keyboard/safe-area behavior and offline/return flows on actual iOS Safari and Android Chrome before launch; desktop emulation is not device certification.

## Local development

```sh
npm ci
npm run build
npm run check
npm test
npm run dev
```

`npm start` runs `node server.js`; `npm run dev` uses Node's watch mode. The local adapter:

- binds only `127.0.0.1` at `PORT`; visit `http://localhost:3000` when using the example origin;
- loads `.env` with `process.loadEnvFile`, ignores only a missing file, and delegates to the same `api/*.js` handlers as Vercel;
- serves regular assets from `public/` with realpath containment, explicit content types, and no directory listings or SPA fallback;
- does not load environment files, start listening, or open storage merely because it is imported;
- exports `createServer({ handlers } = {})` for explicit test-only dependency injection. Normal startup always uses real handlers.

Localhost cannot receive internet webhooks. To test provider callbacks, use a trusted HTTPS tunnel targeting loopback, set `PUBLIC_BASE_URL` to the tunnel's exact origin, and browse through that origin. Do not expose the app with live credentials until the launch checks are satisfied. Only Vercel's trusted forwarding headers are used for customer IP when actually running on Vercel; ordinary local requests use the socket address. A local tunnel is not proof that fiat sees the correct public customer IP.

## Vercel deployment checklist

1. Confirm the merchant's brand, support channel, payout setup, policies, required disclosures, and operational ownership. Clear the provisional name separately.
2. Create/select the target Supabase project with appropriate access controls, capacity, retention, backup/export procedures, and environment separation. Apply `supabase-migration.sql` before deploying the application code. If a migration tool needs a direct Postgres connection, use it only for that migration step; do not add it as an app/Vercel runtime variable.
3. Configure NOWPayments credentials, IPN secret, and the exact enabled coin/network list in the dashboard. Use the dashboard-default payout ticker unless a different provider contract is separately confirmed. This merchant has already completed fiat activation. Leave the optional redirect-host restriction blank unless you intentionally want tighter controls.
4. Add `SUPABASE_URL`, the server-only `SUPABASE_SERVICE_ROLE_KEY`, and the other required environment variables in the correct Vercel scope only after the migration is applied. Use separate preview/sandbox resources and canonical origins; do not reuse production credentials in arbitrary previews.
5. Use repository root as Project Root, Framework **Other** (`framework: null`), **Node 24.x**, Build Command **`npm run build`**, Output Directory **`public`**. `vercel.json` sets API `maxDuration` to 60 seconds; confirm the project/plan supports it. API files remain CommonJS functions under `api/`, not static files.
6. Run `npm ci`, `npm run build`, `npm run check`, and `npm test` against the final code. Review skipped integration tests separately. These commands are instructions, not a claim that a deployment or live test has passed.
7. Verify the final deployment's root/assets and `/api/config`; unknown paths should return 404. Check browser console, CSP headers, mobile dialog layout, keyboard focus, QR readability, network/memo labels, and unavailable-state messaging. A built static page alone is not payment readiness.
8. Set `PUBLIC_BASE_URL` to the final HTTPS origin and make `/api/ipn` reachable by NOWPayments. Vercel deployment protection or an authentication interstitial must not intercept this route. Verify the deployed IPN path does not redirect or require a browser session.
9. Inspect deployment output: publish only intended public assets; `.env*`, order/customer records, tests, local tooling, and credentials must not appear. Ignore files reduce accidental uploads but do not revoke already leaked credentials or delete tracked history.
10. With merchant authorization, perform controlled provider validation: creation, destination/network/memo, exact amount/minimums, signed IPN delivery, non-final versus final settlement, underpayment, retry/idempotency, late-deposit review, and optional fiat KYC/return behavior. Inspect the provider dashboard and Supabase records, not just the UI.
11. Establish alerts for rejected IPNs, provider errors, Supabase failures, and unresolved attempts. Schedule/automate reconciliation only as a separate reviewed operational change; this repository provisions no cron job.

**Unperformed launch gates:** deployment verification, real Supabase integration, provider-issued signature fixtures (including nested arrays), account-specific fiat behavior, and an authorized end-to-end live payment must be checked in the target environment. Neither build nor fixture tests certify these.

## HTTP routes

| Route | Purpose |
| --- | --- |
| `GET /api/config` | Safe public readiness, merchant settings, and enabled capabilities. |
| `GET /api/currencies` | Merchant-enabled, validated asset/network choices. |
| `GET /api/estimate` | Validated quote and minimum information. |
| `GET /api/min-amount` | Network/payout-specific minimum in the requested pricing currency. |
| `POST /api/checkout` | Validate input and session, reserve an idempotent attempt, create the provider payment. |
| `GET /api/status` | Authorized order lookup/reconciliation; returns authoritative receipt state. |
| `POST /api/ipn` | Signature-authenticated provider callback, guarded persisted state updates. |
| `POST /api/reconcile` | Optional operator-only manual reconciliation; never a customer endpoint. |

The browser/API fields are defined by the shared handlers, not by a second local implementation. Unknown `/api/*` and root paths are not rewritten to the frontend; return URLs use queries on `/`.

### Manual merchant reconciliation

If configured, send `POST /api/reconcile` from a trusted operator tool with `Content-Type: application/json`, `Authorization: Bearer <RECONCILIATION_SECRET>`, and `{ "orderId": "...", "paymentId": "..." }`. `paymentId` is optional when already stored. This request can update payment records; do not invoke it as a health check or expose the operator credential to customers.

Use it after reviewing the provider dashboard for an unresolved creation attempt or a late deposit. Confirm the payment's association with the specific order, amount, asset/network, pricing currency, and merchant account before supplying a missing payment ID. The endpoint must still apply the same provider identity, type, and money checks; it is not a manual “mark paid” override. Late deposits after expiration may not trigger another IPN. A timeout is not proof that creation failed: do not create a replacement attempt blindly or tell a customer to pay twice.

## Build, security headers, and licenses

`npm run build` copies **17** specified regular Phosphor icons into `public/icons/` and includes the package's MIT license. It preserves all other public files. Inter and Space Grotesk font files are self-hosted under `public/fonts/`; the build writes their OFL 1.1 notices and source references into `public/fonts/licenses/` without fetching anything. The family licenses were verified from Google Fonts; existing font binaries were not provenance-matched to a specific upstream release.

The local adapter and Vercel send matching CSP: scripts/styles/fonts/connections only from self, images from self or `data:` for QR codes, no frames or objects, no base URL overrides, no framing of this page, and same-origin forms. Camera, microphone, and geolocation are disabled; payment is not disabled by Permissions Policy. Provider-hosted fiat opens through a validated link, not an iframe or cross-origin form. There is no permissive third-party CDN whitelist. Responses use `no-referrer`; API responses are not cached.

`npm run check` is an offline structural/syntax/asset check with a guarded CommonJS module-load smoke gate, not an integration test or a security certification. It does not read `.env` or customer order data, invoke API handlers, create a server/listener, open network connections, or contact Supabase/providers. Run the build first so generated icons/licenses exist. Test doubles are excluded from deployment and are not controlled by a production demo flag.
