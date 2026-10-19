# Tessera

A local, test-mode payments platform whose backend follows the architecture Stripe has documented publicly, with its own brand and UI.

- **Same API.** The `/v1` paths, form encoding, object shapes, error format, pagination, `expand[]` and idempotency follow the public Stripe API. The official `stripe` npm SDK works against it (see `test/sdk.test.ts`).
- **Same internal design.** Patterns come from Stripe's engineering posts: an isolated card vault, layered rate limits, date-based API versions, a double-entry ledger, transactional events and signed webhooks with retries.
- **Local and safe.** Test mode only, with a simulated card network. No real money moves and no external services are needed.

## Quick start (Windows, macOS or Linux)

Requires **Node.js 20.10 or newer**. No database server, Docker or native build is needed: Postgres runs embedded via PGlite (WASM).

```powershell
cd tessera
npm run setup        # install + build dashboard + create demo account
npm start            # http://localhost:4242
```

Sign in with **demo@tessera.local / tessera-demo**, or create a new account on the sign-in page. Keys are under **Developers → API keys**.

```bash
curl http://localhost:4242/v1/payment_intents \
  -u sk_test_YOUR_KEY: \
  -H "Idempotency-Key: 6b3f0a52-1" \
  -d amount=2000 -d currency=usd -d payment_method=pm_card_visa -d confirm=true
```

```js
// Official Stripe SDK pointed at Tessera
const stripe = require('stripe')('sk_test_YOUR_KEY', { host: 'localhost', port: 4242, protocol: 'http' });
await stripe.paymentIntents.create({ amount: 2000, currency: 'usd', payment_method: 'pm_card_visa', confirm: true });
```

| Command | What it does |
| --- | --- |
| `npm start` | API + dashboard + background workers on port 4242 |
| `npm run dev` | Same, restarting on file changes |
| `npm run dev:web` | Vite dev server for the dashboard on 5173 (proxies to 4242) |
| `npm run loadtest` | Load test against a running server: throughput, latency percentiles, which limiter tier answered each 429 (see Scale and reliability) |
| `npm test` | 153 tests: Payment Element and Express Checkout, smart retries, entitlements, billing credits, sharding and zero-downtime data movement, four-tier load shedding, ledger reconciliation, payments, device wallets, one-click checkout, ACH Direct Debit (microdeposits, mandates), Pay in 4, payment method settings, localized and adaptive-currency Checkout, team roles, two-step sign-in, security history, simulated emails, scheduled reports, data export and reset, tax IDs and reverse charge, invoice payment plans, pause collection, Checkout custom fields and consent, search, carbon removal orders, Financial Connections, Capital financing, revenue recognition, Radar metadata rules, file uploads, Persons, Instant Payouts, SQL, per-endpoint webhook versions, Treasury, cash balances, billing thresholds, Terminal, Issuing (with disputes), credit notes, customer balance, shipping, identity verification, multi-currency, tax, quotes, customer portal, usage-based billing, promotion codes, payment links, subscription schedules, saved cards and authentication, disputes, reports, billing (on test clocks), Connect, checkout, webhooks, plus official-SDK compatibility |
| `npm run seed` | Create the demo account |

Environment variables: `PORT`, `DATA_DIR` (default `./data`), `SETTLEMENT_DELAY_SECONDS` (default 120), `PAYOUT_IN_TRANSIT_SECONDS` (5), `PAYOUT_ARRIVAL_SECONDS` (60), `DISPUTE_REVIEW_SECONDS` (30), `DISPUTE_FEE` (1500), `RATE_LIMIT_PER_SECOND` (25), `CONCURRENCY_LIMIT` (50), `WEBHOOK_RETRY_SCHEDULE` (seconds, comma-separated). Delete `./data` to reset everything.

## Architecture

```
Browser ──► tessera.js ──► card iframe (/elements) ──► POST /v1/payment_methods (publishable key)
                                                                  │
Merchant server ──► /v1 API (Fastify) ──────────────────────────► │
  │  request id → auth (keys / session+CSRF) → rate limits → version pin → idempotency
  │  → transaction { domain logic → events outbox } → expand → strip internals → version transform
  ▼
Domain: customers · payment methods · payment intents · charges · refunds · checkout · fraud rules · billing · connect
  │                    │                          │
  ▼                    ▼                          ▼
Document store     Card Data Vault           Ledger (double-entry, append-only)
(objects table)    (own DB + key file,       processor_receivable / refund_payable clear to zero
                   AES-256-GCM, tokens only)
  │
Workers: webhook delivery (HMAC-signed, backoff ~3 days) · settlement (pending → available) · billing · payouts · key pruning
```

| Stripe principle (public source) | Where it lives here |
| --- | --- |
| Card data in an isolated vault; PANs encrypted with AES-256, keys on separate machines, only allow-listed forwarding ([security docs](https://docs.stripe.com/security)) | `src/vault/`: separate PGlite database and key file, AES-256-GCM, HMAC fingerprints, CVC never stored, no API returns a PAN |
| Card fields in Stripe-hosted iframes to cut merchant PCI scope | `public/elements/` + `public/v3/tessera.js`: card data goes from the iframe straight to the API; the parent page gets only `pm_…` |
| Idempotency keys: first response saved and replayed; params must match; pruned after 24 h ([docs](https://docs.stripe.com/api/idempotent_requests)) | `src/platform/http.ts` |
| Four-layer rate limiting with token buckets; fail open ([blog](https://stripe.com/blog/rate-limiters)) | `src/platform/ratelimit.ts`: rate, concurrency and load shedding; 429 + `Stripe-Rate-Limited-Reason` |
| Object locks with `lock_timeout` | `src/platform/locks.ts` |
| Date-based API versions with backward "version change modules" ([blog](https://stripe.com/blog/api-versioning)) | `src/platform/versioning.ts`, including the real 2022-11-15 change (`charges` removed from PaymentIntent) |
| Immutable double-entry Ledger; clearing accounts drain to zero ([blog](https://stripe.dev/blog/ledger-stripe-system-for-tracking-and-validating-money-movement)) | `src/domain/ledger.ts`, **Developers → Ledger** |
| Document store for API objects (DocDB) | `objects` table in `src/db/schema.ts` |
| Events + signed webhooks (`t=…,v1=…`, 5-min tolerance, retries for 3 days) ([docs](https://docs.stripe.com/webhooks)) | `src/domain/events.ts`, `src/domain/webhooks.ts` |
| Radar-style rules (`block if :risk_level: = 'highest'`), value lists, reviews | `src/domain/radar.ts` |
| Restricted keys with per-resource permissions; publishable keys limited to client-safe calls | `src/platform/http.ts` |

## Billing

Subscriptions follow the published Billing model. Products and prices define what is sold. A subscription bills each period in advance through an invoice, and each invoice is paid by a PaymentIntent, so it gets the same fraud rules, ledger postings and webhooks as any payment.

- **Lifecycle.** `incomplete → active`, `trialing → active`, `past_due` after a failed renewal, `canceled` / `incomplete_expired`. Payment behaviours are `allow_incomplete`, `default_incomplete` (confirm the first invoice client-side with its `client_secret`) and `error_if_incomplete`.
- **Renewal engine.** It processes renewals, payment retries (+3, +5, +7 days, then cancel), trial-ending notices (3 days before) and incomplete expiry (23 h) in time order. It runs every second for real time, or instantly when a **test clock** is advanced.
- **Billing periods.** Month-end anchors clamp correctly (Jan 31 → Feb 28 → Mar 31).
- **Prorations.** Changing quantity or price mid-period creates credit and debit invoice items, which land on the next invoice (`create_prorations`), are invoiced now (`always_invoice`) or are skipped (`none`). Changing the interval resets the cycle and invoices immediately.
- **Coupons.** `once`, `repeating` (N months) or `forever`; percentage or fixed amount; redemption limits.
- **Invoices.** One-off invoices from invoice items; `charge_automatically` or `send_invoice` with a due date and a hosted pay page (`/invoices/pay/:id`); finalize, pay, pay out of band, void, mark uncollectible; upcoming-invoice preview.
- **Checkout.** `mode=subscription` (catalog or inline recurring prices, optional trial) creates the customer, saves the card and starts the subscription.

## Connect

A platform onboards connected accounts, charges on their behalf and pays them out. A connected account is a full Tessera account with its own objects, ledger and balance. The platform acts on it with its own secret key plus the `Stripe-Account: acct_...` header (`stripeAccount` in the official SDK and in `tessera.js`).

- **Account types.** `express` and `standard` accounts use Tessera-hosted onboarding (Account Links). `custom` accounts are filled in by the platform through the API. `controller[...]` is accepted as an alternative to `type`.
- **Requirements engine.** `requirements.currently_due` is recomputed after every change. `charges_enabled`, `payouts_enabled` and the `card_payments` / `transfers` capabilities follow from it, and changes emit `account.updated` and `capability.updated`.
- **Identity test values.** Date of birth 1901-01-01 verifies; 1902-01-01 fails and asks for `individual.verification.document`. `file_identity_document_success` clears it. SSN last 4 is `0000`.
- **Charge types.**
  - *Destination charges:* `transfer_data[destination]`, with `application_fee_amount` or `transfer_data[amount]`. On capture a transfer moves the funds from the charge's pending balance, creating a `py_` payment on the connected account and an `application_fee` on the platform.
  - *Direct charges:* made with `Stripe-Account`. The platform's fee is booked in the same ledger group as the capture.
  - *Separate charges and transfers:* `POST /v1/transfers`, optionally with `source_transaction` and `transfer_group`.
- **Refunds.** `reverse_transfer` and `refund_application_fee` reverse in proportion. You can also make transfer reversals and application fee refunds directly.
- **Payouts.** A payout goes `pending → in_transit → paid | failed`, or is canceled while pending. Schedules are `manual`, `daily`, `weekly` or `monthly`. Connected accounts default to daily automatic payouts and new platform accounts to manual. A test bank account number decides the outcome (table below).
- **Ledger.** Every transfer, fee and reversal is one balanced group whose entries belong to two accounts (platform `merchant_pending +X`, connected account `merchant_pending -X`). The health check sums groups across owners. Payouts clear through `payouts_in_transit`.
- **Webhooks.** Endpoints created with `connect=true` receive events from all connected accounts, each with an `account` field.
- **Billing and Checkout.** Subscriptions take `application_fee_percent`, `transfer_data[destination]` and `transfer_data[amount_percent]`. Every invoice turns these into PaymentIntent amounts. Checkout takes `payment_intent_data[application_fee_amount|transfer_data|on_behalf_of]` and the same `subscription_data` fields.
- **Dashboard.** Under **Connect**: connected accounts (create, onboarding links, Express dashboard login, charges, transfers, payouts, bank accounts, payout schedule, reject), transfers with reversals, and collected fees with refunds. **Payouts** covers the platform's own payouts and bank accounts.

| Test bank account (routing 110000000) | Payout result |
| --- | --- |
| 000123456789 / `btok_us_verified` | Paid |
| 000111111116 / `btok_us_verified_noAccount` | Fails: `no_account` |
| 000111111113 / `btok_us_verified_accountClosed` | Fails: `account_closed` |
| 000222222227 | Fails: `insufficient_funds` |
| 000333333335 | Fails: `debit_not_authorized` |

## Saved cards, disputes and reports

**Saved cards (SetupIntents).**
- `POST /v1/setup_intents` saves a card without charging it. Confirming runs a zero-amount check through the vault, plus 3-D Secure when the card asks for it. `confirmCardSetup` in `tessera.js` does this from the browser. `setup_attempts` records each try.
- Checkout `mode=setup` gives a hosted "save your card" page. `setup_future_usage` on a PaymentIntent saves the card during a payment.

**Strong customer authentication.** Cards behave as on the public test-card list, and `off_session=true` payments can't show a challenge:

| Card | Behaviour |
| --- | --- |
| 4000 0025 0000 3155 | Authenticate once at setup; afterwards off-session payments go through |
| 4000 0027 6000 3184 | Every payment needs authentication; off-session fails with `authentication_required` |
| 4000 0082 6000 3178 | Authenticates, then declines for insufficient funds |
| 4000 0000 0000 0341 | Saves fine, but charges decline |

Subscription renewals run off-session. A card that needs the customer moves the invoice to `invoice.payment_action_required`, and the customer finishes the payment on the hosted invoice page.

**Disputes.**
- The simulated issuer opens a dispute for 4000 0000 0000 0259 (fraudulent), 2685 (product not received) and 1976 (inquiry). Card 5423 gets an early fraud warning instead.
- A chargeback withdraws the amount plus a $15 fee and blocks refunds. Respond with `POST /v1/disputes/:id` (evidence; `submit` defaults to true) or accept with `/close`.
- Evidence containing `winning_evidence` wins, which reinstates the amount (the fee is kept). `losing_evidence` loses, and an inquiry with losing evidence escalates to a chargeback. A dispute nobody answers by `due_by` is lost.
- Early fraud warnings stop being actionable once the charge is refunded.

**Reports.**
- `POST /v1/reporting/report_runs` supports `balance.summary.1`, `balance_change_from_activity.itemized.1`, `payouts.summary.1` and `payouts.itemized.1`.
- The worker finishes each run and attaches a CSV `file`, downloadable from `/v1/files/:id/contents`. Amounts are in major units, times in UTC, and windows use `available_on`.
- The ending balance of a summary matches `/v1/balance`. The dashboard's **Reports** page uses the same API.

## Currencies, tax, quotes and the customer portal

**Multi-currency.**
- 17 presentment currencies (including zero-decimal JPY).
- A charge settles in its own currency when the account has a bank account for it. Otherwise it is converted to the default currency at a fixed reference rate, and the balance transaction records the `exchange_rate`.
- Fees follow the published US structure: 2.9% + 30, plus 1.5% for international cards, plus 1% for currency conversion.
- Refunds and disputes convert at the rate on the day they happen. `GET /v1/exchange_rates/:currency` returns the rates.

**Tax.**
- *Manual tax rates* (`/v1/tax_rates`, inclusive or exclusive, and immutable once created) go on invoice items, subscription items, quotes and checkout line items, or as `default_tax_rates`.
- *Automatic tax* is a simplified tax engine:
  - It collects only where you have a `tax.registration` (US state, country, or the EU One-Stop Shop), based on the customer's address.
  - Rates come from a reference table: US state sales tax, EU/UK VAT, Canadian GST/HST/PST/QST, and GST/JCT elsewhere.
  - Product tax codes decide what's taxable (digital `txcd_10000000`, physical `txcd_99999999`, nontaxable `txcd_00000000`). California, for example, doesn't tax digital services.
  - Customers can be `exempt` or `reverse` charge.
  - Invoices list `tax_amounts` per line and `total_tax_amounts`. Finalizing without a usable address fails with `customer_tax_location_invalid`.
- `POST /v1/tax/calculations` and `tax/transactions/create_from_calculation` expose the engine directly.
- Checkout with `automatic_tax` asks for the address on the hosted page and recalculates live.

**Quotes.**
- A quote goes `draft → open (finalize, numbered) → accepted | canceled`.
- Totals use the same discount and tax engine as invoices, with `computed.upfront` (first invoice; trials excluded) and `computed.recurring`.
- `/v1/quotes/:id/pdf` returns a real PDF. Accepting creates the subscription and/or invoice.
- Invoices also get an `invoice_pdf` link.

**Customer portal.**
- `billing_portal.configuration` controls what customers may do: update details, manage cards (SetupIntent + 3-D Secure), see invoices, cancel (at period end or immediately) and switch between chosen plans with a proration preview.
- `POST /v1/billing_portal/sessions` returns the portal URL for one customer.
- Plan-change previews are a dry run inside a transaction that is rolled back.

## Usage-based billing, promotion codes, payment links and schedules

**Pricing models and meters.**
- Prices can be per unit, *package* (`transform_quantity`, e.g. $5 per 100 units, rounded up), or *tiered* (`billing_scheme=tiered` with `graduated` or `volume` tiers, each with an optional flat fee). Sub-cent amounts use `unit_amount_decimal`.
- A `billing.meter` names an event and how to aggregate it (`sum`, `count` or `last`). Report usage with `POST /v1/billing/meter_events` (`identifier` makes it idempotent) and cancel an event with a meter event adjustment. `GET /v1/billing/meters/:id/event_summaries` returns totals per hour or day.
- A *metered* price (`recurring[usage_type]=metered`, `recurring[meter]`) has no quantity on the subscription. The usage of each period is billed in arrears on the renewal invoice, and on a last invoice when the subscription ends. The upcoming invoice includes usage so far. On a test clock, events default to the clock's time.

**Promotion codes.**
- `/v1/promotion_codes` creates customer-facing codes for a coupon (`promotion[coupon]`; older API versions show the embedded `coupon`). Codes are case-insensitive and unique among active codes.
- Limits: `max_redemptions` (the code deactivates when reached), `expires_at`, one `customer`, `restrictions[first_time_transaction]` and `restrictions[minimum_amount]`.
- Apply a code with `promotion_code` or `discounts[0][promotion_code]` on subscriptions, invoices, quotes and Checkout. Checkout's `allow_promotion_codes` adds a code box to the hosted page, and the portal can accept codes on plan changes.

**Payment links.**
- `/v1/payment_links` sells catalog prices from a shareable URL (`/b/test_…`). Every visit opens a new Checkout Session (`payment_link` is set on it). The session uses subscription mode when any price is recurring.
- Options: adjustable quantities, promotion codes, automatic tax, trials and subscription metadata, Connect fees and destinations, a confirmation message or a redirect after payment, and `restrictions[completed_sessions][limit]` (the link deactivates itself when the limit is reached). Inactive links show an "unavailable" page.

**Subscription schedules.**
- `/v1/subscription_schedules` plans phases ahead of time: each phase has its own items, discounts and length (`duration`, `end_date`, or the older `iterations`). The first phase may be a trial.
- A schedule can start later (it creates the subscription on `start_date`) or take over a live subscription (`from_subscription`).
- At each phase boundary the billing engine swaps the items. When the boundary falls on a renewal, the renewal bills the new prices and any change of interval resets the billing cycle. Mid-period changes prorate.
- When the last phase ends, `end_behavior` either keeps the subscription (`release`) or cancels it. `release` and `cancel` are also available on demand. Everything runs on test clocks.

## Credit notes, customer balance, shipping and identity

**Customer balance.**
- `customer.balance` is in the customer's currency: negative is credit, positive is an amount owed. `POST /v1/customers/:id/balance_transactions` adjusts it, and every change is a `customer_balance_transaction`.
- Finalizing an invoice applies the balance (`starting_balance` → `ending_balance`), so `amount_due` can be lower than the total, or zero. Voiding the invoice gives the balance back.

**Credit notes.**
- `/v1/credit_notes` (+ `preview`, `lines`, `void`) adjusts a finalized invoice. Lines credit part of an invoice line (by quantity or amount, with that share of its discount and tax) or add a custom amount.
- On an open invoice, a credit note lowers `amount_due`. An unfinished payment for the old amount is canceled, and the invoice is marked paid when nothing is left to pay.
- On a paid invoice, choose any split of `refund_amount` (refunds the invoice's payment), `credit_amount` (customer balance) and `out_of_band_amount`. With no split given, the whole amount goes to the balance.
- Each credit note gets a number (`<invoice>-CN-01`) and a PDF. A credit note that refunded money can't be voided.

**Shipping.**
- `/v1/shipping_rates` are fixed shipping charges with a delivery estimate.
- In payment mode, Checkout takes `shipping_address_collection[allowed_countries]` and up to five `shipping_options` (existing rates or inline `shipping_rate_data`). The hosted page asks for the address and the method.
- The session reports `shipping_cost`, `total_details.amount_shipping` and `collected_information.shipping_details` (older API versions get `shipping_details`). The PaymentIntent gets `shipping`.
- With automatic tax, the shipping address decides the tax. Shipping is taxed where it is taxable: for example New York yes, California no.
- Payment links support shipping too.

**Identity (simulated).**
- `/v1/identity/verification_sessions` (`document` or `id_number`; optional selfie and ID number) returns a hosted `url`. `tessera.verifyIdentity(client_secret)` opens the same flow in a modal.
- The page collects name and date of birth and lets you pick a test result. The result arrives a few seconds later: `verified`, or back to `requires_input` with a `last_error` the person can retry from.
- Each attempt creates an `identity.verification_report`. `verified_outputs` appears only when expanded, and `redact` erases the collected details. Nothing is uploaded or checked.

## Terminal and Issuing

**Terminal (simulated readers).**
- Create `terminal.location`s, then register readers with the test registration codes `simulated-wpe` (countertop) or `simulated-s700` (handheld).
- Give a reader an action: `process_payment_intent` (the PaymentIntent needs `allowed_payment_method_types[]=card_present`), `set_reader_display` (a cart) or `refund_payment`. It stays `in_progress` until a card is presented with `POST /v1/test_helpers/terminal/readers/:id/present_payment_method` (optionally a test card number and a tip).
- The card creates a `card_present` payment method. Charges carry `payment_method_details.card_present` with an EMV receipt. Declines fail the action with `card_declined`. Readers that are busy return `terminal_reader_busy`, and `cancel_action` stops an action.
- `POST /v1/terminal/connection_tokens` is there for client SDKs.
- In the dashboard, each reader page shows a virtual reader screen: send a payment and present a test card as the customer would.

**Issuing (cards).**
- `POST /v1/topups` with `destination_balance=issuing` funds the Issuing balance (shown in `/v1/balance` under `issuing`).
- Cardholders own virtual or physical cards. The card number and CVC are returned only with `expand[]=number` / `cvc`.
- Spending controls work on cards and cardholders: allowed or blocked merchant categories, and limits per authorization, day, week, month, year or all time.
- Test helpers simulate the card network:
  - `/v1/test_helpers/issuing/authorizations` creates an authorization. It is checked against card and cardholder status, controls and balance, and approved amounts are held.
  - Authorizations can then be captured, reversed, incremented or expired.
  - Force captures, unlinked refunds and transaction refunds are also available.
- Real-time authorization: if a webhook endpoint lists `issuing_authorization.request`, each authorization is posted to it synchronously, signed like any webhook. The endpoint answers `{"approved": true|false}`, optionally with an `amount` to approve part of an amount-controllable authorization. No answer within 2 seconds means a decline (`webhook_timeout`).
- Every hold, release, purchase and refund is a balance transaction and a balanced ledger entry.

## Treasury, cash balances, billing thresholds and Issuing disputes

**Treasury (financial accounts).**
- `/v1/treasury/financial_accounts` hold USD with their own ABA address: routing 110000000, and an account number returned only with `expand[]=financial_addresses.aba.account_number`.
- Balances are `cash`, `inbound_pending` and `outbound_pending`.
- Money moves through:
  - InboundTransfers: an ACH pull from a `us_bank_account` payment method.
  - OutboundPayments: ACH, wire, or to another financial account (posts instantly).
  - OutboundTransfers.
  - ReceivedCredits and ReceivedDebits.
- Every flow has a Transaction with TransactionEntries for each balance change.
- ACH flows settle after a few seconds (`TREASURY_SETTLE_SECONDS`). Test bank account numbers decide failures: `000222222227` insufficient funds, `000111111113` account closed, `000111111116` no account.
- Test helpers succeed, fail, post or return flows on demand, and create received credits and debits.

**Customer cash balance (bank transfers).**
- `POST /v1/customers/:id/funding_instructions` gives each customer a virtual bank account. `POST /v1/test_helpers/customers/:id/fund_cash_balance` simulates their transfer arriving.
- A PaymentIntent with `allowed_payment_method_types[]=customer_balance` is paid from the cash balance. If the balance falls short, the funds available are applied and the PaymentIntent waits in `requires_action` with `display_bank_transfer_instructions`. Later transfers are reconciled automatically: the referenced payment first, then the oldest.
- Canceling returns applied funds, and refunds go back to the cash balance. `GET /v1/customers/:id/cash_balance_transactions` lists every change.

**Billing thresholds.**
- `billing_thresholds[amount_gte]` on a subscription, or `items[][billing_thresholds][usage_gte]` on a metered item, invoices usage as soon as it crosses the threshold (`billing_reason=subscription_threshold`) instead of waiting for the period to end.
- `reset_billing_cycle_anchor` also starts a fresh period. It credits the unused licensed time and bills the new period.

**Issuing disputes.**
- `/v1/issuing/disputes` disputes a card purchase, with a reason and evidence.
- When submitted, an explanation containing `losing_evidence` loses. Anything else wins after the review delay, and the money returns to the Issuing balance.

## Files, Persons, Instant Payouts and SQL

**File uploads.**
- `POST /v1/files` takes `multipart/form-data` with a `purpose` and a `file` part (the official SDKs' `files.create` works as-is). The type is detected from the bytes.
- Each purpose has its own rules: `dispute_evidence` (PDF, JPG or PNG, up to 5 MB), `identity_document` (up to 10 MB), `business_logo` (up to 512 KB), and others.
- `GET /v1/files/:id/contents` returns the original bytes with the right content type and needs a secret key.
- `/v1/file_links` gives a public URL (`/links/<token>`) that stops working at `expires_at` (`expires_at=now` expires it). Sensitive purposes such as `identity_document` can't be linked. `file_link_data[create]=true` makes a link during upload.
- Dispute evidence fields that take files (`receipt`, `shipping_documentation`, `uncategorized_file`, ...) accept uploaded file ids with purpose `dispute_evidence`.
- **Files** in the dashboard lists uploads and report files. Dispute pages have **Attach file** buttons.

**Persons (Connect).**
- `/v1/accounts/:id/persons` (also `/people`) supports create, list (filter by `relationship[owner]=true`, ...), retrieve, update and delete for company accounts.
- A company needs:
  - a representative with full identity details and a title;
  - each listed owner's name;
  - `company[owners_provided]=true`.
- Until a representative exists, requirements read `representative.*`. After that they read `person_xxx.*`. Owners' percentages can't add up to more than 100%.
- Identity documents can be the test tokens (`file_identity_document_success` / `_failure`) or uploaded files with purpose `identity_document`. A file whose name contains "fail" simulates a rejected document.
- The account page has a **People** card. Hosted onboarding for companies now collects the representative.

**Instant Payouts.**
- Debit cards can be external accounts: `tok_visa_debit`, `tok_mastercard_debit`, or the numbers 4000056655665556 / 5200828282828210. They show `available_payout_methods: ["standard","instant"]`.
- `tok_visa_debit_us_transferFail` makes payouts fail (`could_not_process`). `tok_visa_debit_us_instantPayoutUnsupported` is standard only. Credit cards are rejected.
- `method=instant` arrives in seconds (`INSTANT_PAYOUT_SECONDS`).
  - Fee: 1.5% (minimum $0.50), on the payout's balance transaction and taken on top of the amount.
  - A failed payout returns both the amount and the fee.
  - Limit: $10,000 per payout.
- `GET /v1/balance` includes `instant_available` when an eligible card exists.

**SQL (Sigma-style).**
- `POST /v1/tessera/sigma/query` with `sql` runs one read-only statement against a fresh in-memory snapshot of your account. The snapshot covers charges, customers, payment_intents, refunds, invoices, subscriptions, balance_transactions, disputes, payouts, products, prices, coupons and transfers.
- How columns map:
  - References become `*_id` columns, e.g. `charges.customer_id`.
  - Nested objects are `jsonb`, e.g. `payment_method_details->'card'->>'brand'`.
  - Timestamps are `timestamptz`.
- Results are capped at 1,000 rows. `GET /v1/tessera/sigma/schema` lists tables and columns.
- The **SQL** page has a schema browser, starter templates, Ctrl+Enter to run and CSV download.

**Webhook API versions.** `api_version` on a webhook endpoint is validated. Events sent to that endpoint are rendered in that version, for example without `allowed_payment_method_types` before 2026-09-30. The dashboard's endpoint form has a version picker.

## Climate, Financial Connections, Capital, revenue recognition and Radar metadata

**Carbon removal (Climate).**
- `/v1/climate/products` and `/v1/climate/suppliers` describe a fictional catalog: two portfolios with a per-ton price, delivery year, remaining tonnage and suppliers.
- `POST /v1/climate/orders` takes `metric_tons` or `amount`. It is paid from the available balance, with a 3% fee shown as `amount_fees`.
  - Orders are `open`, then `confirmed` after a few seconds (`CLIMATE_CONFIRM_SECONDS`).
  - Canceling refunds the full amount. Delivered orders can't be canceled.
  - Test helpers `.../deliver` and `.../delay` simulate supplier delivery (with a public certificate page) and a one-year delay.
- The **Climate** page buys removal and tracks orders.

**Financial Connections (linked bank accounts).**
- `POST /v1/financial_connections/sessions` asks for `permissions` (balances, ownership, payment_method, transactions) and optional `prefetch`.
- The customer links accounts at `/link-accounts/<client_secret>`, or in an embedded dialog with `tessera.collectFinancialConnectionsAccounts({ clientSecret })`. Test institutions:
  - Tessera Test Bank: checking, savings and a credit card.
  - Low Balance Credit Union: its ACH payments fail with insufficient funds.
  - Down Bank: unavailable.
- Accounts support `refresh` (balance, ownership, transactions), `disconnect`, `subscribe` / `unsubscribe` and `/owners`.
- `/v1/financial_connections/transactions` lists 30 days of deterministic test transactions.
- A linked cash account becomes a payment method with `us_bank_account[financial_connections_account]=fca_...`.
- In the dashboard, **Linked accounts** lists every account with balances and transactions. Each customer page has a **Linked bank accounts** card.

**Capital (financing).**
- `POST /v1/test_helpers/capital/financing_offers/create` (use `Stripe-Account` for a connected account) creates an offer with an advance, a flat fee and a withholding rate.
- The offer lifecycle:
  1. `mark_delivered`.
  2. The business accepts or declines on a hosted application page. Get its link from `POST /v1/tessera/capital/financing_offers/:id/application_link`.
  3. The advance is paid into the business's balance (`CAPITAL_PAYOUT_SECONDS`), and it owes the advance plus the fee.
  4. That share of every card payment is withheld as it becomes available, until the offer is `fully_repaid`.
- Unaccepted offers expire after 30 days.
- `/v1/capital/financing_transactions` and `/v1/capital/financing_summary` follow the repayment. The **Capital** page manages offers and shows progress.

**Revenue recognition.**
- Invoices, payments, refunds and credit notes become a double-entry journal:
  - Subscription periods move from DeferredRevenue to Revenue evenly over the service period.
  - One-time items are recognized when billed.
  - Tax goes to TaxLiability. Refunds and credit notes are contra-revenue.
- `GET /v1/tessera/revenue_recognition` returns monthly billed, recognized and net revenue, the deferred revenue roll-forward (including scheduled months), and a breakdown by product.
- Report types `revenue_recognition.debits_and_credits.1` (the journal) and `revenue_recognition.summary.1` run through `/v1/reporting/report_runs`.
- The **Revenue recognition** page charts it, and **Download journal** exports the CSV.

**Radar metadata rules.** Rules can read `::key::` (PaymentIntent metadata) and `::customer:key::` (customer metadata), for example `block if ::customer:tier:: = 'banned'`. A new `like` operator takes `%` wildcards, for example `:email: like '%@example.org'`. The rule editor has example buttons.

## Tax IDs, payment plans, pause collection, Checkout fields and search

**Tax IDs and reverse charge.**
- `/v1/customers/:id/tax_ids` and `/v1/tax_ids` (owner `customer`, `self` or `account`) store tax IDs. A customer can also be created with `tax_id_data[]`.
- Values are normalized and format-checked for 14 types, including `eu_vat` (with per-country formats), `gb_vat`, `au_abn`, `us_ein`, `ca_bn` and `ch_vat`.
- EU VAT, UK VAT and ABN numbers are verified asynchronously: `pending`, then `verified`.
  - Test numbers containing `111111111` come back `unverified`; `222222222` comes back `unavailable`.
  - Other types are format-checked only (`unavailable`).
- With automatic tax, an EU or UK business customer whose VAT number isn't unverified, buying from a seller in another country, is reverse-charged:
  - the invoice (or Checkout) carries a zero tax line with `taxability_reason=reverse_charge`;
  - the invoice stores `customer_tax_ids`;
  - the PDF shows the tax ID and a reverse-charge note.
- The Tax calculations API accepts `customer_details[tax_ids]` for the same check. Each customer page has a **Tax IDs** card.

**Invoice payment plans.**
- A `send_invoice` invoice can be split into 2 to 12 installments: `amounts_due[i][amount]`, plus `[days_until_due]` or `[due_date]`, and an optional `[description]`. Set them at creation or while it's a draft.
- At finalization they must add up to `amount_due`; otherwise you get `invoice_amounts_due_mismatch`.
- Each installment has a status and due date. The hosted invoice page pays the next installment or the whole remainder. `POST /v1/tessera/invoices/:id/pay_installment` does the same through the API.
- `amount_paid` grows with each installment, and the invoice is paid when the last one is. `invoice.overdue` is sent once per missed installment.
- The PDF lists the schedule, and the invoice page has **Split invoice**.

**Pause payment collection.**
- `pause_collection[behavior]` takes one of:
  - `keep_as_draft`: renewal invoices stay as drafts;
  - `mark_uncollectible`: they are finalized as uncollectible;
  - `void`: they are voided.
- The subscription stays active either way. `pause_collection[resumes_at]` lifts the pause automatically (test clocks respect it), and `pause_collection=` resumes immediately.
- The subscription page has **Pause payments** and **Resume collection**.

**Checkout custom fields, consent and tax ID collection.**
- `custom_fields[]` adds up to three fields, each `text`, `numeric` or `dropdown`, with optional, minimum length, maximum length and default settings. The answers come back on the session (`custom_fields[].text.value`, ...).
- `consent_collection[terms_of_service]=required` adds a required checkbox. `consent_collection[promotions]=auto` adds an opt-in, recorded as `consent.promotions` (`opt_in` or `opt_out`).
- `custom_text[submit|terms_of_service_acceptance]` changes the wording on the page.
- `tax_id_collection[enabled]=true` adds "I'm purchasing as a business". A VAT number recalculates tax on the spot (reverse charge) and is saved to the customer.
- Payment links accept the same options, and the dashboard's link and session forms have them under **Collect**.

**Search query language.**
- Search is available for charges, customers, invoices, payment intents, prices, products and subscriptions at `/v1/{resource}/search?query=...`.
- The syntax supports:
  - `field:"value"` (exact) and `field~"text"` (substring of 3 or more characters);
  - `>`, `<`, `>=` and `<=` on numbers and timestamps;
  - `metadata["key"]:"value"` and `field:null`;
  - `-` for negation;
  - `AND` or `OR` (not both in one query).
- Results are newest first, paged with `page` / `next_page`. `expand[]=total_count` adds a count.
- The dashboard has a global search box: IDs jump straight to the object, and text runs smart queries across resources on a Search page.

## Team, security, emails, scheduled reports and data tools

**Team and roles.**
- **Settings → Team** invites people by email; the invitation lands in the simulated inbox. The person accepts at `/invite/<token>` and chooses a password.
- Roles decide what each person can change in the dashboard. Everyone can read.

  | Role | Can change |
  | --- | --- |
  | Owner | Everything |
  | Administrator | Everything except managing other owners |
  | Developer | All API resources and API keys; not the team |
  | Analyst | Reports and SQL only |
  | Support specialist | Customers, refunds, disputes, invoices, credit notes, subscriptions |
  | View only | Nothing |

- Changes a role doesn't allow are refused with `role_not_permitted`.
- An account always keeps at least one owner. Removing someone signs them out.

**Two-step sign-in.**
- **Settings → Security** adds an authenticator app (TOTP, RFC 6238, 30-second codes). You type the setup key or open the `otpauth://` link.
- In test mode, a built-in authenticator on the setup screen shows the current code.
- Turning it on issues 10 single-use backup codes. Sign-in then asks for a code after the password; each code works once, and five wrong attempts end the attempt.

**Security history.** Owners and administrators see a log of:
- sign-ins, including failed ones;
- two-step changes, invitations, joins, role changes and removals;
- API key creation and rolls;
- data exports and resets;
- email settings;
- dashboard changes to payouts, transfers, refunds, webhooks, Connect, Issuing, Treasury and Capital.

It can be filtered by kind.

**Simulated emails.**
- **Developers → Emails** is an inbox of everything Tessera would send. Nothing leaves your machine.
  - Receipts and refund notices go to the charge's email.
  - Invoices are sent when a `send_invoice` invoice is finalized or `/send` is called.
  - Failed invoice payments get an "update your payment method" email, which links to the customer portal for subscriptions.
  - Trial-ending reminders and team invitations are sent too.
- Each kind can be turned off under **Settings**. The API is `GET /v1/tessera/emails` and `GET /v1/tessera/emails/:id`.

**Scheduled reports.**
- **Scheduled reports** runs a saved SQL query or a financial report daily, weekly or every 30 days. **Run now** runs one immediately.
- Each SQL run is a `scheduled_query_run` with a CSV file (`GET /v1/sigma/scheduled_query_runs`) and sends `sigma.scheduled_query_run.created` to your webhooks.
- Financial reports create report runs, which send `reporting.report_run.succeeded`.
- Manage schedules with `/v1/tessera/report_schedules`.

**Data tools (Settings → Data).**
- **Export** downloads one JSON file: every object, your connected accounts and the ledger, without internal fields.
- **Reset** needs your password and the account name. It deletes all objects, events, the ledger, logs, webhook deliveries, files and connected accounts.
- The team, settings and security history stay. API keys and webhook endpoints are kept unless you choose to replace them.

The demo data adds `support@tessera.local` (Support specialist) and `analyst@tessera.local` (Analyst), both with the password `tessera-demo`, so you can try the roles.

## Payment methods: wallets, one-click, bank debits, Pay in 4 and localized pages

**Settings → Payment methods** turns methods on and off (`/v1/payment_method_configurations`). Checkout Sessions without `payment_method_types`, and PaymentIntents with `automatic_payment_methods[enabled]=true`, offer every method that is on and fits the payment (currency, amount, mode). **Preview Checkout** on the same page opens a test payment page in any language and currency.

| Method | What the customer does | Pricing |
| --- | --- | --- |
| Cards | Types a card into the card form | 2.9% + 30¢ |
| Device wallets | Taps **Pay with wallet**, picks a test card in the simulated wallet sheet, confirms | Card pricing |
| One-click checkout | Enters their email, types the emailed code, pays with a saved card | Card pricing |
| ACH Direct Debit (`us_bank_account`) | Links a bank with Financial Connections, or types routing and account numbers | 0.8%, capped at $5 |
| Pay in 4 (`quartet`) | Approves a four-payment plan on the provider's page | 6% + 30¢ |

**Device wallets.**
- Tessera.js: `tessera.paymentRequest({ currency, total })`, `canMakePayment()`, `show()`, and the `paymentmethod` event with `ev.complete('success' | 'fail')`. `elements().create('paymentRequestButton', { paymentRequest })` renders the button.
- The sheet creates the payment method from a wallet token: `tok_wallet_visa`, `tok_wallet_mastercard`, `tok_wallet_amex`, `tok_wallet_chargeDeclined`, `tok_wallet_authenticationRequired`.
- Wallet cards have `card.wallet.type = device_wallet` with a `dynamic_last4`, and never need 3-D Secure.

**One-click checkout.**
- On a card payment, the customer can tick **Save my details for one-click checkout**. The card is then saved for that email at every Tessera business on this machine.
- Next time, entering the email on any payment page sends a six-digit code to **Developers → Emails**. In test mode `000000` also works.
- After five wrong codes the code stops working. Sessions last 30 minutes.
- The payment uses a new card payment method with `card.wallet.type = oneclick`. Customers can pay another way or remove saved cards.
- The demo data saves a Visa for `jenny.rosen@example.com`.

**ACH Direct Debit.**
- **Mandate.** Confirming needs `mandate_data[customer_acceptance]` or an existing mandate; Checkout records online acceptance. Retrieve it with `GET /v1/mandates/:id`.
- **Verification.**
  - Accounts linked with Financial Connections are verified at once.
  - Typed-in accounts wait in `requires_action` (`verify_with_microdeposits`), with a hosted verification page. Test values: amounts `32` and `45`, or descriptor code `SM11AA`.
  - Verify by API with `POST /v1/payment_intents/:id/verify_microdeposits`; publishable keys need the client secret. After 10 wrong attempts the account is blocked.
  - `payment_method_options[us_bank_account][verification_method]=instant` refuses typed-in accounts.
- **Settlement.**
  - The PaymentIntent is `processing` and its charge `pending` for `BANK_DEBIT_SECONDS` (10 by default). Then the simulated network answers.
  - Account `000222222227` fails with insufficient funds, `000111111113` as closed, `000111111116` as no account, and `000333333335` as not authorized. Closed and unauthorized accounts deactivate the mandate. Other accounts succeed.
  - In Checkout the session completes as `unpaid`. It then sends `checkout.session.async_payment_succeeded` or `checkout.session.async_payment_failed`.

**Pay in 4 (Quartet, a fictional provider).**
- Confirming with a `quartet` payment method needs a `return_url` and returns a redirect to Quartet's approval page, which shows four payments two weeks apart.
- Approving pays you the full amount; declining returns the PaymentIntent to `requires_payment_method` with `payment_method_provider_decline`.
- Limits: $1–$4,000 in USD, CAD and AUD; 1–1,000 in GBP and EUR. Tessera.js: `confirmQuartetPayment`. Shortcut: `pm_quartet`.

**Localized pages and local currencies.**
- Checkout's `locale` can be `auto`, `en`, `de`, `fr`, `es` or `ja`. Hosted invoices follow the customer's `preferred_locales`.
- Customers can switch the language at the bottom of the page. The card form, wallet sheet, amounts and dates follow it.
- With `adaptive_pricing[enabled]=true`, customers can pay in another currency. The rate is the reference rate plus 2%.
- When they do, the PaymentIntent is in that currency. The completed session reports the amount paid, with `currency_conversion` holding the source amounts.

## Payment Element, Express Checkout and billing recovery

**Payment Element.** One embedded form for every method a PaymentIntent accepts: cards, US bank accounts and Pay in 4. Create the PaymentIntent with `automatic_payment_methods[enabled]=true`, and the form shows whatever is on in **Settings → Payment methods**.

```js
const tessera = Tessera('pk_test_...');
const elements = tessera.elements({ clientSecret, appearance: { theme: 'flat', variables: { colorPrimary: '#4f46e5' } } });
elements.create('expressCheckout').mount('#express');
elements.create('payment', { layout: 'accordion' }).mount('#payment');
// on submit:
const { error } = await elements.submit();
const { paymentIntent } = await tessera.confirmPayment({ elements, confirmParams: { return_url }, redirect: 'if_required' });
```

- Layout: `tabs` or `accordion`.
- Appearance: themes `stripe` (default), `night` and `flat`, plus `colorPrimary`, `colorBackground`, `colorText`, `colorDanger`, `borderRadius`, `fontFamily` and `spacingUnit`.
- Languages: en, de, fr, es and ja.
- Card and bank numbers stay inside the element's frame; the page only gets the payment method. Bank payments include the online mandate automatically.

**Express Checkout.** A row of quick ways to pay above the form:
- **Wallet** opens the device wallet sheet.
- **Quick pay** is one-click checkout: email, a six-digit code (000000 in test mode), then a saved card.

Listen for `confirm` and call `confirmPayment({ elements })`; it uses the method the customer picked. **Developers → Elements** is a playground for both, on a real test PaymentIntent.

**Failed-payment recovery (Settings → Billing).**
- *Smart retries* pick each retry time from the decline. Cards that cannot succeed (lost, stolen, expired, wrong number, authentication required) are not retried. Insufficient funds is retried on the next 1st or 15th of the month. Other declines are spaced 1, 2, 2, 3… days apart. Limits: up to 8 attempts within 1 week to 2 months.
- *Custom schedule*: retry a fixed number of days after each failure.
- After the last retry, the subscription is canceled, marked `unpaid` or left past due, and the invoice is left open or marked uncollectible.
- The invoice page shows each attempt, its decline and the reason for the next one (`GET /v1/tessera/invoices/:id/retries`).
- API: `GET`/`POST /v1/tessera/billing_settings`.

**Entitlements.**
- Create features (`/v1/entitlements/features`, each with a `lookup_key`) and attach them to products (`/v1/products/:id/features`).
- A customer's active entitlements (`/v1/entitlements/active_entitlements?customer=`) come from their active, trialing and past-due subscriptions.
- When the set changes, `entitlements.active_entitlement_summary.updated` carries the full new list.
- The dashboard has **Billing → Features**, a Features card on products, and an Entitlements card on customers.

**Billing credits.**
- A credit grant (`/v1/billing/credit_grants`) gives a customer prepaid or promotional credit for metered prices. It has a priority, plus optional start and expiry dates.
- At finalization, credit is applied to usage lines before tax: lowest priority number first, then the grant that expires soonest. The invoice lists it in `total_pretax_credit_amounts`.
- Voiding the invoice gives the credit back; voiding or expiring a grant removes what is left.
- Every change is a credit balance transaction (`/v1/billing/credit_balance_transactions`), and `/v1/billing/credit_balance_summary` gives the available balance.
- Customers have a Billing credits card to grant, review and void credit.

## Scale and reliability

Tessera applies the mechanisms Stripe has described publicly for running at very high volume. **Developers → System health** shows them live.

**Sharded storage.**
- API objects live in a Postgres table split by shard: `objects_s0` … `objects_s3`, each with its own indexes. `SHARD_COUNT` sets the number; it can be raised later, never lowered.
- `shard_directory` maps each account to its shard and a version. New accounts go to the least-loaded shard, and reads and writes go to the account's shard only.
- Databases from earlier versions are converted automatically on first start.

**Zero-downtime moves.** `POST /v1/tessera/shard_moves` with `target_shard` moves your account in six steps:
1. Register the move and start capturing writes.
2. Bulk-copy a snapshot.
3. Replay writes made during the copy.
4. Verify by checksum.
5. Switch: requests wait for under 2 seconds while the rows are swapped in one transaction.
6. Clean up.

The account keeps serving requests throughout. A move cut short by a restart is abandoned, and the account stays where it was. Check progress with `GET /v1/tessera/shard_moves/:id`.

**Four tiers of protection.** Every 429 carries `Stripe-Rate-Limited-Reason` naming the tier.

| Tier | Rule | Setting |
| --- | --- | --- |
| Rate limiter | Token bucket per API key | `RATE_LIMIT_PER_SECOND` (25) |
| Concurrency limiter | Requests in flight per account | `CONCURRENCY_LIMIT` (50) |
| Fleet shedder | Above 80% of capacity, only critical requests (creating and confirming payments) get in | `FLEET_CAPACITY` (200) |
| Worker shedder | When the event loop falls behind, sheds dashboard reads first, then API reads, then other writes; never critical requests | `SHED_LAG_MS` (500) |

`POST /v1/tessera/system/simulate_load` with `event_loop_delay_ms` makes the server act overloaded, to try the worker shedder. An empty value clears it.

**Ledger reconciliation.** Runs hourly (`RECONCILE_SECONDS`) and on demand (`POST /v1/tessera/reconciliation_runs`). Five checks:
- every ledger group sums to zero;
- clearing accounts hold exactly the money still in flight;
- every captured charge, refund and payout has its ledger entries;
- balances equal their balance transactions;
- nothing stays pending past its available date.

Failures list example ids.

**Measuring.**
- `GET /v1/tessera/system` returns live traffic (requests per second, p50/p95/p99 latency), limiter state, and the shards.
- `TESSERA_PROFILE=1` adds the slowest SQL statements.
- `npm run loadtest -- --seconds 20 --concurrency 32` runs a checkout-like mix. Start the server with `RATE_LIMIT_PER_SECOND=100000` to measure capacity rather than the per-key limit.
- On one CPU core, Tessera handles about 40 requests a second, because all shards share one embedded database. Splitting shards into separate processes ("cells") is the next round.

## API surface

`/v1/account` · `/v1/balance` · `/v1/balance_transactions` · `/v1/customers` (+ `/search`) · `/v1/payment_methods` (+ attach/detach) · `/v1/payment_intents` (+ confirm/capture/cancel) · `/v1/charges` · `/v1/refunds` · `/v1/events` · `/v1/webhook_endpoints` · `/v1/checkout/sessions` (+ line_items/expire) · `/v1/radar/rules` · `/v1/radar/value_lists` · `/v1/reviews` (+ approve/refund) · `/v1/products` · `/v1/prices` · `/v1/coupons` · `/v1/subscriptions` · `/v1/subscription_items` · `/v1/invoices` (+ finalize/pay/void/mark_uncollectible/send, `/upcoming`, `/create_preview`, `/:id/lines`) · `/v1/invoiceitems` · `/v1/test_helpers/test_clocks` (+ advance) · `/v1/accounts` (+ reject, login_links, capabilities, external_accounts) · `/v1/account_links` · `/v1/tokens` (bank accounts) · `/v1/transfers` (+ reversals) · `/v1/application_fees` (+ refunds) · `/v1/payouts` (+ cancel) · `/v1/setup_intents` (+ confirm/cancel) · `/v1/setup_attempts` · `/v1/disputes` (+ close) · `/v1/radar/early_fraud_warnings` · `/v1/reporting/report_types` · `/v1/reporting/report_runs` · `/v1/climate/products` · `/v1/climate/suppliers` · `/v1/climate/orders` (+ cancel) · `/v1/financial_connections/sessions` · `/v1/financial_connections/accounts` (+ refresh/disconnect/subscribe/unsubscribe/owners) · `/v1/financial_connections/transactions` · `/v1/capital/financing_offers` (+ mark_delivered) · `/v1/capital/financing_summary` · `/v1/capital/financing_transactions` · `/v1/tax_ids` · `/v1/customers/:id/tax_ids` · `/v1/{charges,customers,invoices,payment_intents,prices,products,subscriptions}/search` · `/v1/files` (+ upload, contents) · `/v1/file_links` · `/v1/accounts/:id/persons` · `/v1/tax_rates` · `/v1/tax/registrations` · `/v1/tax/calculations` · `/v1/tax/transactions` · `/v1/quotes` (+ finalize/accept/cancel/pdf/line_items) · `/v1/billing_portal/configurations` · `/v1/billing_portal/sessions` · `/v1/exchange_rates` · `/v1/billing/meters` (+ deactivate/reactivate/event_summaries) · `/v1/billing/meter_events` · `/v1/billing/meter_event_adjustments` · `/v1/promotion_codes` · `/v1/payment_links` (+ line_items) · `/v1/subscription_schedules` (+ cancel/release) · `/v1/customers/:id/balance_transactions` · `/v1/credit_notes` (+ preview, preview/lines, lines, void) · `/v1/shipping_rates` · `/v1/identity/verification_sessions` (+ cancel/redact) · `/v1/identity/verification_reports` · `/v1/terminal/locations` · `/v1/terminal/readers` (+ process_payment_intent, set_reader_display, refund_payment, cancel_action) · `/v1/terminal/connection_tokens` · `/v1/topups` · `/v1/issuing/cardholders` · `/v1/issuing/cards` · `/v1/issuing/authorizations` · `/v1/issuing/transactions` · `/v1/test_helpers/terminal/readers/:id/present_payment_method` · `/v1/test_helpers/issuing/*` · `/v1/treasury/financial_accounts` (+ close, features) · `/v1/treasury/inbound_transfers` · `/v1/treasury/outbound_payments` · `/v1/treasury/outbound_transfers` · `/v1/treasury/received_credits` · `/v1/treasury/received_debits` · `/v1/treasury/transactions` · `/v1/treasury/transaction_entries` · `/v1/test_helpers/treasury/*` · `/v1/issuing/disputes` (+ submit) · `/v1/customers/:id/cash_balance` · `/v1/customers/:id/cash_balance_transactions` · `/v1/customers/:id/funding_instructions` · `/v1/test_helpers/customers/:id/fund_cash_balance` · `/v1/payment_method_configurations` · `/v1/mandates/:id` · `/v1/payment_intents/:id/verify_microdeposits` · `/v1/tessera/system` · `/v1/tessera/shards` · `/v1/tessera/shard_moves` · `/v1/tessera/reconciliation_runs`. Platform introspection lives under `/v1/tessera/*` (ledger, logs, deliveries, versions, connect overview).

## Test cards

| Number | Result |
| --- | --- |
| 4242 4242 4242 4242 | Succeeds |
| 4000 0025 0000 3155 | Requires 3-D Secure (redirect to the test challenge page) |
| 4000 0000 0000 0002 / 9995 / 9987 / 0069 / 0127 | Generic decline / insufficient funds / lost card / expired / incorrect CVC |
| 4000 0000 0000 0119 | Processing error |
| 4100 0000 0000 0019 | Highest risk; blocked by the default fraud rule |
| 4000 0000 0000 9235 | Elevated risk |
| 4000 0000 0000 0077 | Funds available immediately |
| 4000 0007 6000 0002 · 4000 0082 6000 0000 | Brazil · UK card (country rules) |

Shortcuts such as `pm_card_visa`, `pm_card_chargeDeclined`, `pm_card_authenticationRequired` and `pm_card_radarBlock` work wherever a `payment_method` is accepted.

## Design system

`web/src/tokens.css` defines three token tiers: **core** values (jade and stone ramps, a 4/8px spacing scale, radii), **semantic** roles re-pointed for dark mode, and **component** tokens that the components read. Two-layer tinted shadows, `@layer reset, base, components, pages`, a focus ring on every control, `prefers-reduced-motion` support and a skip link.

## Roadmap

1. **Core payments**: done.
2. **Billing**: done (products, prices, coupons, subscriptions, invoices, prorations, retries, test clocks).
3. **Connect**: done (accounts, hosted onboarding, Express dashboard, destination and direct charges, transfers, application fees, payouts).
4. **Saved cards, disputes, reporting**: done (SetupIntents, off-session authentication rules, chargebacks and inquiries with evidence, early fraud warnings, report runs with CSV files).
5. **Customer portal, tax, quotes, multi-currency**: done.
6. **Usage-based billing, promotion codes, payment links, subscription schedules**: done.
7. **Credit notes, customer balance, shipping rates, identity verification**: done.
8. **Terminal and Issuing**: done.
9. **Treasury, customer cash balances, billing thresholds, Issuing disputes**: done.
10. **File uploads, Persons, Instant Payouts, SQL, per-endpoint webhook versions**: done.
11. **Carbon removal, Financial Connections, Capital, revenue recognition, Radar metadata rules**: done.
12. **Tax IDs and reverse charge, invoice payment plans, pause collection, Checkout custom fields and consent, search**: done.
13. **Team roles, two-step sign-in, security history, simulated emails, scheduled reports, data export and reset**: done.
14. **Device wallets, one-click checkout, ACH Direct Debit in Checkout, Pay in 4, localized pages and adaptive currencies**: done.
15. **Scale and reliability: sharded storage, zero-downtime moves, four-tier load shedding, ledger reconciliation, metrics and a load test**: done.
16. **Payment Element and Express Checkout; smart retries, entitlements and billing credits**: done.
17. Next: cells. Each group of shards runs in its own process with a front router, read replicas and simulated failover, so throughput grows with CPU cores.
18. Later: SEPA, Bacs, BECS and ACSS debits, ACH for subscriptions; a webhook and test-event command line; embedded Connect components.
"# Tessera_REA_Stripe_Clone" 
