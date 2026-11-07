# NOWPayments contract notes and launch limits

Research references were retrieved **November 5, 2026**. That is the retrieval date, not a claimed vendor update date or a comprehensive point-in-time certification. Provider/account behavior and third-party on-ramp terms must be validated again before launch.

## Sources

- [Official NOWPayments API collection](https://documenter.getpostman.com/view/7907941/2s93JusNJt)
- [Official Payment Widget product page](https://nowpayments.io/payment-widget)
- [Raw official Postman collection](https://documenter.gw.postman.com/api/collections/7907941/2s93JusNJt?segregateAuth=true&versionTag=latest)
- [Vercel request-header contract](https://vercel.com/docs/headers/request-headers)

The collection is the endpoint/request-shape reference for this implementation. Some official historical help text conflicts with it: older Mercuryo-related help said fiat API access was unavailable, while the current collection and April 10/11, 2025 on-ramp material describe a Guardarian/direct API flow. This is not evidence that every merchant account can use that flow. Account activation/KYB and a verified direct response are release prerequisites.

## Chosen integration

### Crypto: native inline dialog

`POST /payment` returns `payment_id`, `pay_address`, `pay_amount`, pricing/pay currencies, and status. The server validates these against the stored order and presents the required address, exact amount, network, optional destination tag/memo, and generated QR in the app's own dialog.

The QR currently encodes the address, not a universal payment URI carrying every chain's amount/memo semantics. The user must verify the displayed network and required tag separately. Do not call this a NOWPayments embedded widget; no provider iframe is loaded.

Use `GET /payment/{id}` for reconciliation of the stored provider payment ID. Never infer payment success from a return query, client storage, elapsed time, a copied address, or a QR scan.

### Fiat: direct provider-hosted redirect only

The selected API path is direct `POST /payment` with the fiat-on-ramp contract. The response must identify `type: "fiat2crypto"` and contain `redirectData.redirect_url`. The app validates the payment's identity before accepting that server-returned HTTPS URL as the hosted checkout. Exact hostname restrictions are optional. The request includes the documented `origin-ip` header derived from a trusted request source, never from customer JSON.

The integration enables the documented pricing currencies **USD, EUR, ILS, GBP, AUD, RON** only when the account/configuration permits. Merchant on-ramp activation/KYB, customer KYC, region restrictions, provider limits, fees, and available payment methods still apply. Do not promise universal Visa/Mastercard/AMEX or geography coverage.

There is **no invoice fallback**. An invoice flow needs different authenticated lookups/identifiers and cannot be treated as interchangeable with a payment. An unavailable, ambiguous, or malformed direct response fails closed and preserves creation uncertainty rather than issuing another provider attempt.

### Official widget exists; it is not yet integrated here

The official Payment Widget product page was verified in the browser. It explicitly advertises **“No redirection”**, **“Fiat-to-crypto conversion”**, and instructs merchants to configure payment preferences in the NOWPayments Dashboard, generate widget code, and embed it on their site. This confirms an official inline widget exists; it does not establish how to bind this application's custom amount and stored order to that widget.

The current app still uses its own crypto modal and the direct API's hosted fiat URL. Research did not establish the merchant-specific widget code, documented per-order/custom-amount parameters, iframe permissions for any KYC/3DS handoff, or a reliable order-status association. Before replacing this flow, obtain the generated widget embed snippet or documented per-payment embed contract from the merchant's dashboard/provider. Do not send API/IPN secrets as part of an embed snippet.

No guessed `/embeds/...` URLs, cross-origin HTML proxying, or success-by-message behavior is used. CSP keeps `frame-src 'none'` until the documented integration is implemented. A future widget may be hosted inside the page's dialog, but external identity/card verification must not be promised to remain inline without testing.

## Endpoint and data rules

| Operation | Selected official contract | Implementation requirement |
| --- | --- | --- |
| Enabled assets | `GET /merchant/coins` returns `{ currencies: [...] }` filtered by merchant dashboard settings | Treat merchant configuration as authoritative, not a generic fallback list. |
| Asset metadata | `GET /full-currencies` returns `{ currencies: [{ code, name, network, enable, extra_id_exists, ... }] }` | Validate shape, availability, exact tickers/networks, and required tags; intersect with enabled assets. |
| Estimate | `GET /estimate?amount=...&currency_from=...&currency_to=...` | Use those parameter names; estimates are not final settlement and must be revalidated at creation. |
| Minimum | `GET /min-amount?currency_from=<pay asset>&currency_to=<payout asset>&fiat_equivalent=<pricing fiat>&is_fixed_rate=false&is_fee_paid_by_user=false` | **Both currency tickers are required.** `currency_to` comes from required `NOWPAYMENTS_PAYOUT_CURRENCY`, matching the primary payout/balance ticker in the merchant dashboard, never the pricing fiat by assumption. |
| Create | `POST /payment` | Persist expected identity/money and an idempotency reservation before calling. Validate direct crypto or fiat response; do not guess missing IDs/URLs. |
| Status | `GET /payment/{payment_id}` | Match stored order ID, provider ID, pricing currency/amount, pay currency/type, and final payment amounts before advancing state. |
| Callback | `POST /api/ipn`, header `x-nowpayments-sig` | Verify signature, validate identity/money/status, and persist guarded updates before acknowledging. |

The minimum result's `fiat_equivalent` is numeric in the **requested pricing currency**. `min_amount` is in the relevant crypto unit; never compare it directly with a fiat input. Payout/network settings affect the minimum. Disable unsupported combinations rather than substituting a guessed coin, network, minimum, rate, or payout ticker.

The provider base is `https://api.nowpayments.io/v1`, or `https://api-sandbox.nowpayments.io/v1` when explicitly configured for the provider sandbox. API credentials remain server-side. Redirects on credential-bearing backend requests are not allowed. Browser CSP is not a backend egress firewall: maintain a fixed provider API base and trusted Redis endpoint independently of browser policy.

## IPN verification and payment state

The documented signature is HMAC-SHA512 over JSON with object keys sorted alphabetically at every nesting level, keyed by `NOWPAYMENTS_IPN_SECRET`. Verify a strict 128-hex-character signature using constant-time comparison. The same signed payload still needs order/business validation; a correct MAC alone is not proof that it belongs to the requested checkout.

Vercel's Node request body getter may already supply parsed JSON. The shared body adapter must accept that shape as well as a string, Buffer, or unread Node request stream, enforce size/object constraints, and decode streamed UTF-8 only after collecting complete bytes. This signature contract is canonical JSON, not blindly HMACing arbitrary raw bytes.

**Remaining fixture limitation:** official Node/Python canonicalization examples disagree on some array handling. The current implementation preserves array order/type while recursively sorting object keys, rejects mismatches, and does not relax verification to accept arbitrary serializations. A real provider-signed nested-array fixture is still required before claiming complete payload-shape compatibility.

Only `finished`, matched to the persisted order/payment identity with full expected money verified, represents a paid order. `waiting`, `confirming`, `confirmed`, `sending`, partial payment, and unknown provider states are not final settlement. Refunds, expiration, failure, and manual-review conditions must remain distinct. A failed/canceled browser flow is not grounds to promise “nothing was charged.”

Use versioned atomic Redis updates to tolerate simultaneous status polling and callbacks without regressing settlement. Network errors, non-JSON responses, and timeouts after creation must remain unresolved/unknown until reconciled; a fresh POST is not a safe default retry. Test repeat idempotency keys, changed-payload conflicts, duplicate/out-of-order callbacks, webhook-before-create-response races, and Redis failures.

## Trusted IP, origins, and hosted redirects

`PUBLIC_BASE_URL` is an exact configured origin, HTTPS in production. Callback/return URLs must not come from arbitrary Host, forwarded-host, or request-body values. Browser session/origin protection is separate from the signature-authenticated provider IPN route.

Vercel documents that its edge overwrites forwarding IP headers to prevent spoofing; `x-vercel-forwarded-for` is the authoritative counterpart and `x-forwarded-for` follows the documented edge contract. Trust those headers only when configuration establishes the Vercel runtime. Otherwise use the socket's remote address; do not treat arbitrary local proxy headers as authoritative. Do not accept a customer-supplied IP in the checkout body.

The merchant has confirmed that fiat activation/KYC is complete. `NOWPAYMENTS_FIAT_ENABLED` therefore defaults to `true`; it is an optional local off switch, not automatic approval detection. The inspected public API does not document a read-only fiat on-ramp approval-status endpoint. Do not confuse `/fiat-payouts/*` cashout capabilities with customer fiat acceptance.

`NOWPAYMENTS_FIAT_REDIRECT_HOSTS` is an optional comma-separated exact-host restriction. When empty, the app accepts only an absolute HTTPS checkout URL obtained from the fixed NOWPayments API's authenticated payment response after order/type validation; the URL never comes from customer input. Validation rejects credentials, control characters, non-HTTPS URLs, unexpected ports, IP literals and local/internal hostname suffixes. If configured, the host list must parse completely and match exactly; invalid lists disable fiat. No browser CSP widening or undocumented iframe integration is introduced.

## Manual reconciliation and operations

`POST /api/reconcile` is an optional operator-only endpoint, enabled by a separate `RECONCILIATION_SECRET` of at least 32 characters. It expects `Authorization: Bearer <secret>` and JSON `{ "orderId": "...", "paymentId": "..." }`; the provider payment ID is optional when already known. Without the secret configured, it is unavailable. No cron is provisioned and this is not a browser/customer API.

After checking the provider dashboard, the merchant can reconcile a known payment or attach the verified provider ID to an uncertain creation attempt. Confirm the merchant account and order association first. The endpoint must still enforce all identity/type/amount checks rather than overriding an order to “paid.” An expired payment may receive a late deposit without another IPN, so an operational dashboard/reconciliation procedure is necessary even with functioning webhooks.

Use durable Redis credentials/permissions, suitable retention and backups, alerts, and an accounting export/reconciliation process. Do not log signing credentials, bearer/session tokens, full payment bodies, or customer IPs unnecessarily. Preview and production must not share payment credentials or webhook origins by accident.

## What has not been certified

Source review and fixture tests are not vendor/account certification. The merchant reports that fiat onboarding is complete; no repeat onboarding is requested. Before launch, verify the final deployment, Redis connectivity/atomic behavior, API credentials, merchant-enabled assets, payout ticker, minimums and fees, public IPN delivery, provider-signed fixtures, account-specific fiat responses, any optional redirect restrictions, and an authorized controlled end-to-end live payment. No successful live payment or production deployment is asserted by this document.
