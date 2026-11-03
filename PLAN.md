# The Discount Window — plan, architecture and SDLC

> **Working journal, not the submission.** Numbers in this file are the ones that were true when
> the entry was written; several were later corrected (the refused count, the test count, the demo
> invoices). The current truth is the running app, `README.md` and `DEVPOST.md`. Read this for the
> reasoning, not for a figure.


Status: built and measured, 2026-10-30. This file is the design record; the README is the product page.
Event: PayPal AI Hackathon (Devpost). Closes Thu 12 Nov 2026, 21:00 WAT.
Repo: new, `discountwindow`, MIT. No code reused from any earlier project.

This document is the thing to argue with. Nothing gets built until it is agreed,
because the two failure modes found by review are structural, not cosmetic: who
holds the money, and whether 90 seconds can carry the story.

---

## 0. Verified vs unverified

Verified today, with a source and a date:

| Claim | Evidence |
|---|---|
| Seller Protection requires shipping to the transaction address; redirecting voids it | paypal.com/us/legalhub/paypal/seller-protection, page dated 2026-01-26, fetched 2026-10-29 |
| Item Not Received needs proof of delivery with 'delivered' status and a matching address | same page |
| US-primary PayPal account is a basic requirement | same page |
| The $750 signature rule applies only to transactions processed before 2026-01-26 | paypal.com/us/cshelp/article/...help177, fetched 2026-10-29 |
| PayPal is not a neutral escrow for third parties; money settles to a merchant account | PayPal product model; no escrow API exists |
| A capture response carries `seller_protection.status` (`ELIGIBLE` / `PARTIALLY_ELIGIBLE` / `NOT_ELIGIBLE`) and `dispute_categories` | developer.paypal.com Orders v2 `seller_protection` definition; capture examples show `{"status":"ELIGIBLE","dispute_categories":["ITEM_NOT_RECEIVED","UNAUTHORIZED_TRANSACTION"]}`, checked 2026-10-29 |
| `seller_receivable_breakdown` is not present in every capture response | PayPal API v2 reports; it is omitted under some account types and flows — the fee must fall back to the transactions reporting API |
| Orders create/capture, Add Tracking, webhook signature verification, Payouts endpoints | developer.paypal.com API references, 2026-10-29 |

Measured against the sandbox app on 2026-10-29 and 30, with saved responses in `evidence/d0/`:

| Result | Response |
|---|---|
| OAuth client credentials | 200, 26 scopes |
| Orders create, one purchase unit | 201, order id returned |
| Orders create, two purchase units, two different payees, INSTANT disbursement | **201, order `9MG67652J5689432D`** |
| Payouts from the business account | 201, batch created, status PENDING |
| Sandbox personal accounts, provisioned by script | Adaptive Accounts returns `ack: Success` |
| Orders create with `payment_source.card`, server-side | 422 `PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING` — merchant is a Nigeria-country sandbox business account |
| Buyer approval of an order in the browser, then API capture | Order reaches `APPROVED`; capture returns 201 and the order reaches `COMPLETED` |
| Capture, one purchase unit, US payee | 201, capture `6HE796326B655533X`, status PENDING (buyer funded by bank/eCheck), `seller_protection.status = NOT_ELIGIBLE` |
| **Capture, one order, two purchase units, two different payees** | **201, order COMPLETED, two distinct captures: `8KU97245AM022784H` $0.90 to `dw-funder-01`, `0DJ389603U333234R` $0.10 to `dw-funder-02`** |
| The same split, confirmed at the payer's ledger | The buyer's activity feed lists −$0.90 to `dw-funder-01` and −$0.10 to `dw-funder-02`. Two receivers, one order. |
| **Capture, one order, three payees at 20/30/50** | **201, order COMPLETED, captures `3HL15889SJ722022X` $0.20, `43M97402UB703411Y` $0.30, `7D0883560J436545Y` $0.50. Payer feed: three payments to three accounts. This proves a third payee can ride the same order; the desk's own maturity order is **two** units (funder, seller), because PayPal takes its fee from each payee rather than as a unit of its own.** |
| `amount` and `payee` inside the capture response | Absent on the split units. The app must reconcile amounts against the order resource, not the capture. |
| `payee` on `GET /v2/payments/captures/{id}` | Returns the **payer** account, even for split captures. Allocation must come from the order's purchase units, never from this field. |
| Capture response fields on a personal payee | `seller_protection` present; `seller_receivable_breakdown` absent — confirms the caveat that the fee is not always returned |
| NG-country business account as a checkout payee | `checkoutweb/genericError` with `PAYEE_ACCOUNT_LOCKED_OR_CLOSED` — a NG sandbox business merchant cannot receive |
| Split capture bodies | No `payee`, no `amount` and no `payer` block on either unit. `payer.payer_id` exists only on the order resource; the app reads allocation from the order, then `GET`s the order after capture. |
| `custom_id` on a purchase unit | Echoed back on the capture's order and on dispute resources — the app's first attribution path. Both order builders set `custom_id` = invoice id. |
| `POST /v1/notifications/simulate-event` | Accepts `webhook_id` + `event_type` + `resource_version` and delivers a **signed canned sample**; rejects any caller-supplied `resource` with `400 MALFORMED_REQUEST_JSON` naming `/resource`. A simulated event cannot be aimed at one invoice. |
| Signed sample delivered to the app | `verify-webhook-signature` returns `SUCCESS`; stored as `verified = 1`. A hand-posted body with fake transmission headers is stored as `verified = 0` and changes nothing (`evidence/published/x4-simulate.json`). |
| `POST /v1/customer/disputes` with `PayPal-Auth-Assertion` | `400` — "No permissions to set target_client_id". Filing a dispute on a buyer's behalf needs partner permissions this app does not have. |
| Buyer-filed case in the Resolution Center | The case is not a dispute; no `CUSTOMER.DISPUTE.*` event is emitted, and `GET /v1/customer/disputes` is empty because this app's account is not the disputed merchant. |
| Buyer UI on a split order | Only "Unauthorized activity" is offered — merchandise claims are ineligible for multi-payee orders. That case then demanded a password reset before it would proceed. |
| One account as both payer and payee | Refused at checkout: "You are logging into the account of the seller for this purchase". A maturity approval therefore needs a debtor account that is not a payee. |
| Card funding of a split order | `422 PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING` even on the US payees; card expiry must be `YYYY-MM`. |
| A live funding capture of the pinned invoice | Order `07H42099RL265081V` COMPLETED: `7G077633WE973480T` $489.76 to the seller and `8XN5263642050782V` $3.25 to the platform, both PENDING (bank-funded). Recorded in `evidence/published/x5-live-funding.json`; `scripts/relink-funding.ts` restores the state after a reseed. |
| Model pass, live, on a real uploaded POD (2026-10-30) | `gemini-3.8-flash-free` returned six fields at confidence 1.00 each; both readers agreed, the reconciled row carried no findings, and the gate returned VERIFIED with the invoice priced. |
| Same model, second upload inside its window | HTTP 429 `rate_limit_exceeded` ("at most 1 successful request per minute per account"); the row records the reason, the parser answers, and the gate still returns VERIFIED. |
| Same model, third upload inside the cooldown | No network call is made; the row records the deferred window. |
| Paid route on the same gateway | `gemini-3.8-flash` returns 402 `insufficient_credits`, so the free reader is the only model route available to the build. |
| Vision pass on a photographed POD (2026-10-30) | The same OpenAI-compatible route accepts an `image_url` part: `gemini-3.8-flash-free` transcribed all fourteen printed lines of `temp/scanned-pod-verified.jpg` (195,293 bytes, no text layer) and returned the field set at 0.91–1.00. Eleven checks passed, advance $948.36 on a $1,250.00 face. Invoice `inv_e6ec2229abb749d9850e`. |
| Vision pass, first attempt | `HTTP 503 system_cpu_overloaded` from the free route. The reason was persisted verbatim on the extraction and the invoice stayed `REFUSED / POD_UNREADABLE` — a failed read is a refusal with a sentence attached, not a retry hidden from the desk. |
| Image read with a *second* model | The gateway's other models (`qwen3.8-flash`, `gemini-3.8-flash`) return 402 on this key, and `EXTRACT_API_KEY` and `GEMINI_API_KEY` are the same account, so a scan gets one reader of pixels, not two. The transcription is the corroboration surface instead. |
| Two jurisdiction profiles, one codebase (2026-10-30) | The seeded book verifies `MT-2207` — Royal Mail `RB123456789GB` delivered to `12 Old Street, London EC1R 1PG` — under the GB profile (60-day window, 120-day tenor, Purchase Protection): advance $1,821.12 on a $2,400.00 face, evidence sha256 `ee8e8f6d…`. The identical bundle decided with the US profile is refused `TRACKING_INVALID` and `ADDRESS_MISMATCH` with the other nine checks unmoved, and on a 120-day-tenor variant of the same document `TERMS_INVALID` joins them. Written out in `evidence/published/x7-jurisdiction-profiles.json`. |
| Refund of a live capture | Not reachable in this sandbox: every capture ever created here is `PENDING` (bank/eCheck funding), and the Refunds API reverses only `COMPLETED` captures. Probed 2026-10-30 across `7G077633WE973480T`, `8XN5263642050782V`, `8KU97245AM022784H`, `0DJ389603U333234R`, `6HE796326B655533X`, `7D0883560J436545Y`, `3HL15889SJ722022X`, `43M97402UB703411Y` — all `PENDING`, `refundable=false`; `4MK94760HY727411X` and `1TD92077S84307342` return 404. |
| Current code opened against a book written by an earlier commit (2026-10-30) | `Error: no such column: tracker`, thrown before the app could serve a page: the schema created the tracker index, and SQLite adds the column only in the migration that runs *after* the schema. An index on a migrated column therefore breaks every upgrade. The index is now created after the `ALTER`, and `tests/schema.test.ts` builds a pre-tracker file, opens it, and asserts the column appears, the index follows, the old row survives with `tracker = NULL`, and a second open is a no-op. |

The NG-country business row is the finding that matters commercially: the merchant of record must
be a **US business sandbox account**, not merely "US-primary" in the abstract. The NG account can
create orders, sign NVP calls and send Payouts, but no buyer can pay it.

Unverified, and therefore D0 experiments before any product code:

| Question | Why it decides the architecture | Status 2026-10-30 |
|---|---|---|
| Does a US-country sandbox merchant accept `payment_source.card`, so a capture can run with no buyer login? | If yes, the demo's money beats are scriptable and the recording risk disappears. | **No.** Card capture is refused (`PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING`) and one account cannot be both payer and payee. The money beats run with one human approval click each; see §4. |
| Can the chosen model route read a scanned POD reliably? | If not, the build accepts text-layer PDFs only and says so. | **Yes, on one reader of pixels.** The route accepts an `image_url` part and transcribed a photographed receipt cleanly (§0, 2026-10-30). What it cannot do is read the paper twice: the gateway's other models are 402 on this key, so the corroboration for a scan is the model's own transcription run through the deterministic parser, which catches a mis-mapped label and nothing else. The card says so. |

Answered since the last revision: the buyer can approve in the browser and the capture can run
later from the API — the order held `APPROVED` for minutes and captured cleanly. Off-camera
approval is therefore available as a fallback even if X5 stays blocked. X5's card path did not
open (see §4), so the live funding capture ran with one real approval click by the funder; the
capture itself, the payee split and the ledger posting were all server-side.

If both multi-payee and Payouts fail in sandbox, the "PayPal settles" claim is not
real and the build stops. That is a kill criterion, not a workaround. Both passed, so the
criterion is no longer open.

---

## 1. The product

A receivables exchange for US small businesses where nothing is listed for funding
until an agent has verified the delivery evidence. The seller uploads an invoice and
its proof of delivery; the agent extracts the fields, runs eleven deterministic checks,
scores the debtor from the platform's own history, and prices the discount. Anything
without proof of delivery is refused, with the failed check and the document region
shown. Verified invoices are listed in slices; funders buy a slice; the debtor pays
at maturity; the ledger allocates the payment by ownership and shows the exact PayPal
fee taken at capture.

The refusal is the product. A factoring marketplace is a commodity; one that refuses
to fund an unverifiable receivable, and can show why, is a control.

---

## 2. Event contract

| Field | Value |
|---|---|
| Event | PayPal AI Hackathon (Devpost) |
| Closes | Thu 12 Nov 2026, 21:00 WAT |
| Prize pool | $67,500 cash; sponsor prizes separate |
| Rubric | Five criteria, 20 each: Technological Implementation, Design, Potential Impact, Innovation/Idea, Presentation |
| Stage One | Pass/fail: fits the theme, reasonably applies the PayPal APIs |
| AI requirement | A project must integrate the PayPal developer platform **and** an AI tool/model |
| Reuse | New, or existing and meaningfully updated. This is new. |
| Artefacts | Devpost text, public repo with licence visible in About, public video under 3:00 |
| Video limits | No third-party trademarks, no copyrighted music |

Judge-facing consequence: the AI must be visible and load-bearing, but it must not be
the thing that decides whether money moves. That boundary is designed in section 11.

---

## 3. Users and money flow

Three roles:

- **Seller** — a US SMB with an unpaid invoice and a delivery receipt. Wants cash now.
- **Funder** — buys a slice of a verified receivable at a discount. Wants yield and evidence.
- **Debtor** — owes the invoice. Pays at maturity through a PayPal link.

Money moves twice per invoice:

1. **At funding.** The funder pays for its slice. The seller receives the advance
   (slice minus the discount) and the platform receives its fee, in the same capture.
2. **At maturity.** The debtor pays the face value. The payment is allocated pro rata
   by ownership: the funder receives the slice amount, the seller receives the rest,
   and PayPal's actual capture fee is deducted and shown.

No money moves at listing, at scoring, or at refusal.

### The honesty boundary

If multi-payee orders work, money never sits in a platform balance: each capture splits
to its payees. The platform is an arranger, not a custodian.

If they do not work, the fallback is: the platform is merchant of record, money lands in
its PayPal account, and it pays out with Payouts. That is custody and, in production,
money transmission. The submission would then say so on the first screen and in the
README, and the product would be presented as a sandbox prototype that requires a
licensed partner to operate. We do not use the word escrow in either case.

---

## 4. PayPal surface

| Capability | Endpoint | Used for |
|---|---|---|
| OAuth | `POST /v1/oauth2/token` | Every call |
| Create order | `POST /v2/checkout/orders` | Funding payment, debtor payment, corrected links |
| Capture | `POST /v2/checkout/orders/{id}/capture` | Take the money, read the actual fee |
| Order lookup | `GET /v2/checkout/orders/{id}` | Reconcile before acting |
| Payouts (fallback only) | `POST /v1/payments/payouts` | Pay funders/seller if custody path is used |
| Webhook verification | `POST /v1/notifications/verify-webhook-signature` | Reject forged events |
| Webhook simulation | `POST /v1/notifications/simulate-event` | Deliver a signed sample to prove the verify path; cannot be aimed at an invoice |
| Refund | `POST /v1/payments/captures/{id}/refund` | Produces a genuine `PAYMENT.CAPTURE.REFUNDED` event that resolves to its invoice and freezes it |
| Webhooks consumed | `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED`, `CUSTOMER.DISPUTE.CREATED`, `CUSTOMER.DISPUTE.RESOLVED`, payout item events | State transitions |
| Disputes (read-only) | `GET /v1/customer/disputes` | Freeze a funded receivable when the rail reports a dispute |

Sandbox base: `https://api-m.sandbox.paypal.com`. The client refuses to start if the base
URL is not the sandbox host.

### D0 experiments

Each is a script with a saved JSON response and a pass/fail line. No product code until
all four return.

| # | Experiment | Pass means | Status 2026-10-30 |
|---|---|---|---|
| X1 | Token, then create and capture a $1.00 order with one payee | Baseline works; fee is returned | **pass** — create 201, approved, capture 201, order COMPLETED |
| X2 | One order, two `purchase_units`, different payees; capture | Multi-payee splits; the architecture is custody-free | **pass** — 201, order COMPLETED, two distinct captures for $0.90 and $0.10 |
| X3 | Payout of $1.00 from the business account to a sandbox personal account | Fallback settlement works | **pass** (201, batch PENDING) |
| X4 | Webhook delivery with signature verification, replayed twice | Signature verifies; replay is ignorable | **pass** — `verify-webhook-signature` returns SUCCESS on a PayPal-delivered sample; a duplicate body is rejected by event id; an unsigned body is stored as unverified and ignored |
| X5 | US-country merchant + `payment_source.card` capture | Server-side capture with no buyer login | **partly blocked** — card capture is refused (`PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING`), and a payer cannot also be a payee. The money beat is proven instead with one human approval click and a server-side capture (`x5-live-funding.json`) |

Decision matrix:

- X1 + X2 pass → **Architecture A**, custody-free. Payouts not used in the product. **Selected.**
- X1 passes, X2 fails, X3 passes → **Architecture B**, custody with a stated boundary.
- X1 passes, X2 and X3 fail → stop and write `BLOCKED.md`; the settlement claim cannot be demonstrated.
- X1 fails → stop; nothing else is meaningful.

Selected on evidence, 2026-10-30: Architecture A. The saved `x2-us-capture.json` shows one
order, two purchase units and two capture ids, and `x2-payer-feed.json` shows the payer's own
ledger with two outgoing payments of $0.90 and $0.10 to two different accounts. No platform
balance is created at any point, so the money-transmission objection is answered by the
platform's own behaviour rather than by an argument.

One honest caveat travels with that proof. The payees were US **personal** sandbox accounts,
because the available business account is NG-country and cannot receive; a business merchant is
a provisioning task, not an architectural unknown. The buyer also funded by bank, so both
captures settled as PENDING rather than instantly. Neither caveat touches the claim being made —
that a single order can settle to more than one payee.

The run also produced a design rule that goes straight into the ledger code: `capture.payee`
echoes the **payer**, so settlement allocation is read from the order's `purchase_units`, and the
capture id is only used to reconcile amounts. Getting this wrong would have posted every funder's
slice to the wrong account while every test still passed.

### Webhook attribution and freeze (built 2026-10-30)

A verified event is resolved to an invoice in this order, and any step that does not find a real
invoice stops rather than guesses:

1. `resource.custom_id` — both order builders stamp the invoice id on every purchase unit.
2. An order id in `resource.supplementary_data.related_ids.order_id`, or in any `links` href that
   matches `/orders/{id}` or `/checkout/orders/{id}` — checked against `maturity_orders` first, then
   `commitments → slices`.
3. A capture id from `resource.id`, a `/captures/{id}` link, or `disputed_transactions[].seller_transaction_id`
   — matched against the comma list in `commitments.capture_id`, then `maturity_orders.captures_json`.

`CUSTOMER.DISPUTE.CREATED`, `PAYMENT.CAPTURE.REFUNDED` and `PAYMENT.CAPTURE.REVERSED` freeze the
position (`disputed`), recording the status it held in the audit chain; `CUSTOMER.DISPUTE.RESOLVED`
releases it back to that status. Both capture routes refuse to run against a frozen invoice, and a
second freeze on an already-frozen position is a no-op. `tests/webhook.test.ts` proves each resolution
path and each refusal to act, including an event that names nothing held.

The honest limit: no genuine `CUSTOMER.DISPUTE.CREATED` could be produced. Filing one through the API
needs partner permissions, a buyer-filed case is not a dispute, and a multi-payee order only offers
"Unauthorized activity" in the buyer UI. The dispute branch is therefore exercised by the signed-sample
path and by tests; the **refund** branch is the genuinely reachable one, and refunding the pinned
invoice would freeze a funded position in front of a judge, so it is left as a documented action rather
than performed on the demo data.

### Seed and reseed semantics (decided 2026-10-30)

`npm run seed -- --reset` replaces the database file; the seed is deterministic in shape but not in
ids, so a reseed invalidates every order id in the UI. Two rules follow: the seed never issues an
invoice in the future (dates derive `due` from `issued`, and `deliveredOn` from `issued`), and the
stored evidence hash is the SHA-256 **of the document text shown on the page** — the synthetic books
used to salt their hashes, which would not survive a reviewer recomputing one. `relink-funding.ts`
restores the measured funding afterwards from `evidence/published/x5-live-funding.json`, and refuses
to run if the evidence and the price disagree.

Four dataset lies were removed on 2026-10-30, all found by comparing what the seed *claimed* with
what the gate *decided*:

- The generated `CONSIGNEE_MISMATCH` fixtures appended a word to the debtor's own name
  ("Juniper Packaging Freight"). `namesMatch` is written to tolerate exactly that — a legal-suffix
  variant still matches — so 96 invoices the seed labelled as refusals were verified, and the
  archive disagreed with the seed log by that many. The fixture now uses a different company, and the
  plan matches the verdict: re-seeded on 2026-10-30 the gate refused exactly the 618 it planned, by
  reason (210 `POD_MISSING`, 148 `ADDRESS_MISMATCH`, 96 `CONSIGNEE_MISMATCH`, 74 `TRACKING_INVALID`,
  26 `NOT_DELIVERED`, 26 `DELIVERY_DATE_OUT_OF_WINDOW`, 38 `NO_SIGNATURE_EVIDENCE`), the desk's band
  limit refused 5 more at pricing (`BAND_LIMIT`, with the price reason attached), and the two pinned
  demo refusals take the book to 625 refused of 1,005. The published figure is read from the gate's
  rows, never from what the seed intended.
- A refusal code that existed in the documentation but in no data. The late-delivery fixtures set
  `delivered: false` as well as the stale date, so all 52 refused as `NOT_DELIVERED` and E03's second
  code, `DELIVERY_DATE_OUT_OF_WINDOW`, appeared nowhere in 1,005 invoices while README and DEVPOST
  listed it as one of the reasons the archive shows. The fixture now drives the two halves of E03
  apart — 26 undelivered, 26 delivered 140 days before the invoice — so each code in the table has a
  count in the book behind it.
- Every fixture claimed `protection.status = ELIGIBLE`. The sandbox never returns that (measured:
  `UNKNOWN` and `NOT_ELIGIBLE`), so the desk was asserting a PayPal fact no transaction produced.
  Fixtures now pass `UNKNOWN`, E00 records the sandbox override, and the book contains zero
  `ELIGIBLE` rows. The claim survives on the gate tests and the measured capture bodies, not on
  invented data.
- `matured` was displayed as "Matured" on an invoice whose maturity order had only been *created*.
  The label is now "Due, awaiting debtor"; the status still means the order exists and nobody has
  paid it, and the deal room shows the approval link.

The same pass fixed two merge bugs in the reader: a value only the deterministic parser found was
dropped from the merged bundle (the model's `undefined` won), and the stored extraction omitted the
document text, which left the evidence panel blank on any live upload. Both are covered by
`tests/extract.test.ts`.


---

## 5. Architecture

```
Browser (server-rendered HTML)
        |
        v
Node HTTP server  ── routes ── templates
        |
        ├── evidence  : upload, hash, text/vision extraction
        ├── gate      : eleven deterministic checks -> verdict + reasons
        ├── score     : debtor scorecard from ledger history (YAML weights)
        ├── price     : discount formula, fee reserve, integer cents
        ├── market    : slices, commitments, funding order
        ├── settle    : maturity payment, allocation, fee reconciliation
        ├── ledger    : double-entry postings, balance assertion
        ├── audit     : one row per decision, hash-chained
        ├── paypal    : OAuth, orders, capture, payouts, webhook verify
        └── ai        : extraction only; JSON schema; never decides
        |
        v
SQLite (node:sqlite)  +  evidence files on disk (gitignored)
```

Stack, fixed:

- Node 24, TypeScript run natively (no build step), no web framework.
- `node:http` with a small router; server-rendered templates with HTML escaping.
- `node:sqlite` for durability, transactions and unique constraints. One file, backed up per run.
- One parsing dependency for YAML (`yaml`) and one for PDF text (`pdfjs-dist`, legacy build).
- Money as integer minor units everywhere. No floating point in any stored amount.
- All timestamps UTC ISO 8601; display in the browser's zone only in the UI layer.

---

## 6. Data model

Core tables (columns abbreviated):

| Table | Key columns |
|---|---|
| `sellers` | id, paypal_merchant_id, legal_name, country, created_at |
| `debtors` | id, legal_name, normalized_name, billing_address_json, limit_cents, created_at |
| `invoices` | id, seller_id, debtor_id, invoice_number, face_cents, currency, issued_on, due_on, po_ref, status |
| `evidence_files` | id, invoice_id, path, sha256, mime, bytes, uploaded_at |
| `extractions` | id, evidence_id, model, model_version, raw_json, fields_json, confidence_json, created_at |
| `checks` | id, invoice_id, check_id, passed, detail, rule (the sentence as the deciding profile rendered it), evidence_region, created_at |
| `decisions` | id, invoice_id, kind, verdict, reasons_json, inputs_hash, created_at |
| `scores` | id, debtor_id, invoice_id, components_json, score, band, created_at |
| `prices` | id, invoice_id, annual_rate_bp, tenor_days, fee_reserve_cents, discount_cents, advance_cents, platform_fee_cents |
| `slices` | id, invoice_id, funder_id, share_bp, principal_cents, status |
| `commitments` | id, slice_id, paypal_order_id, capture_id, amount_cents, status |
| `ledger_accounts` | id, code, kind (asset/liability/revenue/equity), owner_ref |
| `ledger_entries` | id, txn_id, account_id, debit_cents, credit_cents, memo, created_at |
| `payouts` | id, batch_id, receiver, amount_cents, status, paypal_payout_item_id |
| `webhook_events` | id, event_id UNIQUE, type, payload_json, verified, received_at, processed_at |
| `audit_log` | id, seq, kind, subject_id, payload_json, prev_hash, hash, created_at |

Invariants enforced in SQL, not in prose:

- `webhook_events.event_id` unique.
- `commitments.paypal_order_id` unique; one funding order per slice.
- `(debtor_id, invoice_number)` unique; the same invoice cannot be financed twice.
- `evidence_files.sha256` unique across invoices.
- `ledger_entries`: for every `txn_id`, `sum(debits) = sum(credits)`, checked in a trigger and in tests.
- `audit_log.seq` monotonic; `hash = sha256(prev_hash || canonical(payload))`.

---

## 7. State machines

Invoice:

```
received -> extracting -> REFUSED
                      \-> verified -> scored -> priced -> listed
                            -> partially_funded -> funded -> matured -> settled
                                                              \-> late -> collected
                                                              \-> disputed (frozen)
```

Slice: `offered -> committed -> paid -> settled` (or `cancelled`).

Payment/order: `created -> approved -> captured -> allocated` (or `denied`, `expired`).

Rules:

- No transition out of `REFUSED` except a new invoice id. A refusal is terminal.
- `funded` requires `sum(share_bp) = 10000`.
- `settled` requires a captured debtor payment and a balanced ledger transaction.
- `disputed` freezes settlement allocations and writes an audit row.

---

## 8. The evidence gate

Eleven checks — ten on the documents, one on the payment rail — all deterministic, all in `rules/checks.yaml`. Each has an id, a plain-English
rule, the fields it reads, and a refusal code. Every refusal shows the code, the failed
rule in one sentence, and the evidence region that failed.

| ID | Check | Refusal code |
|---|---|---|
| E00 | The underlying PayPal transaction is protected by the country's programme and carries a tracker for this delivery | `PROTECTION_INELIGIBLE` |
| E01 | Proof of delivery document present and readable | `POD_MISSING` / `POD_UNREADABLE` |
| E02 | Carrier and tracking number present and well-formed for a carrier this profile believes | `TRACKING_INVALID` |
| E03 | Delivered status is true and the delivery date is within the profile's window before the invoice date | `NOT_DELIVERED` / `DELIVERY_DATE_OUT_OF_WINDOW` |
| E04 | Consignee name matches the debtor (normalized legal name or a recorded alias) | `CONSIGNEE_MISMATCH` |
| E05 | Delivery address matches the debtor billing address under the profile's postal-code rule | `ADDRESS_MISMATCH` |
| E06 | Evidence file hash, and the normalised tracking number it carries, have not appeared on another invoice | `EVIDENCE_REUSED` / `TRACKER_REUSED` |
| E07 | Invoice number is unique for this debtor and not already financed | `INVOICE_ALREADY_FINANCED` |
| E08 | Invoice total equals the sum of its line items, and the PO reference matches when supplied | `AMOUNT_MISMATCH` |
| E09 | Dates are coherent: issued_on <= due_on, tenor inside the profile's cap | `TERMS_INVALID` |
| E10 | Signature or delivery photo present | `NO_SIGNATURE_EVIDENCE` |

Each check reads named document fields, and the profile's `minimumConfidence` floor is applied in the
one function every check reports through: a field read below the floor stops the check from passing on
it, so E03, E05 and E10 refuse as `POD_UNREADABLE` on a shaky delivery date, address or signature the
same way E02 and E04 are stopped by a shaky tracker or consignee. A below-floor *absence* is not
converted — a missing signature line still fails as `NO_SIGNATURE_EVIDENCE`, because that is a piece of
evidence the seller can go and find.

**Jurisdiction profiles, built 2026-10-30.** The numbers the sentences read — the carrier table, the
postal-code shape and normalisation, the delivery window, the tenor cap, the confidence floor, and what
PayPal calls the protection — live in `rules/jurisdictions.yaml`, one profile per country code, and the
gate resolves the profile from `debtor.billingAddress.countryCode` at decision time. Rule sentences in
`checks.yaml` carry `{placeholders}` filled from that profile, so the page prints the rule as the country
that applied it. Two profiles ship: US (four carriers, ZIP+4, 90/90, Seller Protection) and GB (five
carriers including Royal Mail/DPD/Evri, postcode, 60/120, Purchase Protection), each with a `notModelled`
list recording what the gate does *not* read there (VAT number, FCA perimeter, UCC-1, state licensing).
The seeded book verifies one invoice under each — `A-1042` under US, `MT-2207`, a Royal Mail receipt to a
London debtor, under GB — and `tests/jurisdiction.test.ts` decides the same document under both profiles
and asserts exactly which checks can move: read with the United States tables the British receipt is refused
`TRACKING_INVALID` and `ADDRESS_MISMATCH`, and pushed to a 120-day tenor `TERMS_INVALID` joins them, while
the name match, the arithmetic, the evidence hash, the delivery window and the receipt signature do not.
The scorecard, the price and the
ledger are untouched by the profile: this build keeps a single settlement currency (USD) for every
invoice, and the deal room says so.

Extraction is not the gate. The AI fills fields with confidence; the checks decide.
A field read below the profile's floor is a refusal (`POD_UNREADABLE`) wherever a check was about to
pass on it — never a guess, and never a green tick next to a number the desk called unreliable.

E00's sandbox caveat, raised in review round 2. Test transactions do not always carry
production eligibility rules, so a sandbox capture can return `PARTIALLY_ELIGIBLE` or
`NOT_ELIGIBLE`. The status is read and stored on day 0 for every capture the build makes.
If sandbox returns a non-eligible status for a fixture that would be eligible in production,
the demo runs with a labelled sandbox override: the screen says the status came from a
sandbox capture and was overridden, the README says the same, and the override is written to
the audit chain like any other decision. It is never silent, and it never applies to a
production account.

---

## 9. Scorecard and pricing

Debtor score, 0–100, from the platform's own history. No bureau data is implied.

| Component | Weight | Rule |
|---|---|---|
| On-time rate | 40 | 40 × paid_on_time / invoices_due |
| Average days late | 15 | 15 at 0 days, linear to 0 at 30 days |
| Outstanding exposure | 15 | 15 × (1 − outstanding / limit) |
| Relationship length | 10 | min(months_active / 24, 1) × 10 |
| Dispute rate | 10 | 10 × (1 − disputes / invoices) |
| Invoice size vs limit | 10 | 10 × (1 − face / limit) |

Bands and terms:

| Band | Score | Risk premium | Max advance share | Tenor cap |
|---|---|---|---|---|
| A | 85–100 | 0% | 90% | 90 days |
| B | 70–84 | 6% | 80% | 90 days |
| C | 50–69 | 15% | 60% | 60 days |
| D | < 50 | — | 0% | refused |

`annual_rate = base_rate (8%) + premium`. Discount is computed on the **net slice**,
after a fee reserve of 2.9% + $0.30, so the quoted rate is a net yield:

```
gross_slice   = face × share
fee_reserve   = round(gross_slice × 0.029) + 30
net_slice     = gross_slice − fee_reserve
discount      = round(net_slice × annual_rate × tenor_days / 365)
advance       = net_slice − discount
platform_fee  = round(face × 0.005)          (charged to the seller at funding)
```

Worked example, used as a pinned fixture:

```
Face $48,000.00 · 60 days · score 78 (Band B) · share 60%
gross slice  $28,800.00
fee reserve  $   835.50
net slice    $27,964.50
discount     $   643.57   (14.0% annual, 60/365)
advance      $27,320.93
platform fee $   240.00   (seller)
```

At maturity the actual PayPal fee returned by capture replaces the reserve. The
difference is posted to a variance account and shown; it is never silently absorbed.
Example: fee $1,392.30 on $48,000 → net $46,607.70 → funder $27,964.62, seller $18,643.08.

---

## 10. Funding, settlement and the ledger

### Architecture A — custody-free (selected 2026-10-30, X2 measured pass)

- Funding order: the funder's single payment has purchase units for the seller (advance)
  and the platform (fee).
- Maturity order: the debtor's single payment has purchase units for each funder slice
  owner and the seller, proportional to `share_bp`.
- The platform stores no balance. The ledger records entitlements and reconciles captures.
- If a maturity order cannot name several payees for one debtor, that invoice cannot be
  listed; the UI says so before listing, not after funding.

Allocation rule, forced by a measured quirk: `GET /v2/payments/captures/{id}` returns
`payee` = the **payer**. The ledger therefore takes each payee and amount from the order's
`purchase_units`, and uses the capture only to confirm that the amount was taken. A capture id is
mapped to a purchase unit through the capture's position in `order.purchase_units[].payments.captures[]`,
and `supplementary_data.related_ids.order_id` on the capture is asserted equal to the order under
settlement before any posting. A test pins this: a fixture where `capture.payee` disagrees with the
unit payee must still post to the unit payee.

### Architecture B — custody fallback (not selected, retained as documented alternative)

- The platform is merchant of record for both payments; money lands in its account.
- Payouts pay each funder and the seller; `sender_batch_id` is the settlement id, unique.
- The first screen and the README state the custody boundary and that production
  operation requires licensing. No use of the word escrow.

### Ledger

Double entry, four account types:

- `platform:clearing` (asset)
- `funder:<id>:receivable` (asset)
- `seller:<id>:payable` (liability)
- `platform:fee_revenue` (revenue)
- `platform:fee_variance` (revenue)

Every capture posts one balanced transaction. A test asserts, for every `txn_id`,
debits equal credits, and that no account goes negative except `clearing` during a capture.

### Idempotency

| Action | Key | Duplicate behaviour |
|---|---|---|
| Funding order | `slice_id` unique in `commitments` | Return the stored order; never create a second |
| Capture | PayPal `capture_id` unique | Ignore replay; no second allocation |
| Webhook | `event_id` unique | Mark processed; no state change |
| Settlement payout | `sender_batch_id = settle:<invoice_id>` | PayPal rejects duplicates; we also check |
| Refusal | invoice id terminal | A new upload creates a new invoice id |

---

## 11. AI layer

The AI is visible, load-bearing, and fenced.

**Does:** reads the POD document and returns structured fields with a confidence value
and a quoted source line.

**Does not:** decide the verdict, the score, the price, or any payment. It cannot approve
an invoice, override a failed check, or produce a number that enters the ledger. It does not
draft seller or funder prose in this build either — the role cards are computed from the price.

**Model:** a second reader, not a gate. Every document is read twice — once by a language model,
once by a deterministic label parser — and the two answers are reconciled field by field:

| Case | Merged confidence |
|---|---|
| both readers agree | the higher of the two |
| only one reader found the value | 0.75 (the value is kept, whichever reader found it) |
| the readers disagree | half of the lower one — under the 0.70 floor, so no check may pass on that field |

The parser is literal label matching: it only fills a field when an explicit label is followed by a
value on the same line. It cannot infer, so a model outage can only leave fields missing, and a
missing required field is a refusal. That is why the fallback is safe: unavailability never turns a
thin document into a verified one.

**Measured on 2026-10-30.** A real POD uploaded through `/submit` was read by
`gemini-3.8-flash-free` with six fields at 1.00, both readers agreed, and the invoice priced with
all eleven checks passed. A second upload inside the same minute returned 429; the row recorded
the window, the parser answered, and the gate still verified. A third upload inside the cooldown
made no network call at all. The paid route on that gateway (`gemini-3.8-flash`) answers 402
`insufficient_credits`, so the free reader is the only model route this build can use — and the
deal room says so on the page rather than hiding it.

**A photograph of paper, measured 2026-10-30.** `scripts/make-scan.ps1` renders a delivery receipt as
a JPEG — rotated 1.7°, sensor-noised, stamped and signed, 195,293 bytes, no text layer anywhere in
the file. `src/extract.ts` sends it to the same chat route as an `image_url` part with a prompt that
asks for the field set **and** a verbatim `"transcription"`. The transcription then becomes the
document text, so `extractDeterministic` runs over it and the merge table above applies unchanged.
That is the whole design decision: the vision pass sits in front of the two readers, never inside the
gate. What it buys is a parser that can still contradict the model's *mapping* — a tracking number
the field pass invents is absent from its own transcription and falls to 0.75, a consignee it
restates disagrees and refuses. What it cannot buy is a second look at the paper: the gateway's other
models answer 402 on this key and both env keys name the same account, so there is one reader of
pixels. The card states where the text came from. Result: fourteen lines transcribed, six fields at
0.91–1.00, eleven checks passed, $948.36 advance on a $1,250.00 face. The first attempt on the same
fixture returned `503 system_cpu_overloaded`, the reason was stored verbatim, and that invoice stayed
refused — the failure path is the success path with a different sentence in it.

**Cadence is part of the design, not a failure.** The free tier allows one successful request per
minute per account. `extractWithModel` remembers a 429's window in-process, so a burst of
submissions spends one request, not a pile of rejections; each row stores the exact reason, and
the deal-room card prints it under the confidence list. With no key configured the card says the
parser read the document and nothing was inferred.

**Failure modes, all safe:**

- Model unreachable, rate-limited or returning malformed JSON → the parser answers, the reason is
  stored, and a field the parser cannot find is still a refusal.
- Low confidence after reconciliation → refusal with the field named.
- Text-layer PDF or text file → both readers see the file's own bytes. Photograph and PNG → the vision
  pass supplies the text, and the card records that it did.
- The model's values are used only when they survive reconciliation against the parser; a field
  the two readers dispute is refused rather than resolved in the model's favour.

Every extraction row stores model id, version, raw JSON, field confidences and the
document hash. Every decision row stores the extraction id it used.

---

## 12. The screen

Three server-rendered pages plus one archive, one visual system. No client secrets.
No client-side framework: the pages are server-rendered HTML and CSS, and JavaScript appears only
in the print button.

**`/` — the book.** Every invoice as a row: seller, debtor, face, tenor, status, score,
discount, days to maturity. Status is text, not colour alone. The top line states the rule:
"Nothing is listed until delivery evidence is verified."

**`/submit` — intake.** The seller uploads the invoice and the proof of delivery; the response is
the gate's verdict, not a receipt.

**`/invoices/:id` — the deal room.** Left: the evidence document with highlighted regions.
Centre: which jurisdiction profile decided this and the numbers it supplied, then the eleven checks,
each pass/fail with its one-line rule as that profile rendered it; the refusal card when failed,
with the code and the evidence region. Right: score breakdown, pricing arithmetic, slices,
and the action. Below: the settlement receipt and the audit chain for this invoice.

**`/ledger` — the settlement book.** Server-rendered tables over ledger entries, grouped by
transaction, plus the account totals and the inbound-webhook feed. The zero-balance assertion
is computed in SQL and rendered as a pinned row. **No client-side grid is used**: AG Grid was
in the plan while the ledger was an interactive island, and the ledger ended up as a printed
book — so the library is absent rather than bolted on to qualify for a sponsor prize.

**`/archive` — the refusal archive.** Every refusal, newest first, with its code, rule,
document region, and the date. A count sits at the top: refusals by code, refusals this week,
verified invoices beside them. This screen exists because impact is a number, not a claim: a
judge can read "620 refused, 384 verified" in two seconds and quote it back in deliberation.

**Roles.** Three views over the same data, chosen by `?view=` on the deal room and the book:
desk (the machine), seller (advance now, remainder at maturity, what the funder pays), funder
(share, principal committed, yield after PayPal's fee, and the approval action). Views change
emphasis, never permissions — the point is to make a two-sided market legible without building
auth into a sandbox demo.

**15-second test.** A stranger lands on a refused invoice and should say, unprompted:
"the delivery proof didn't match the buyer, so it won't be funded, and here's the document
line that failed." If they say "nice dashboard", the screen is wrong.

**Design tokens.** Warm paper, ink, one oxblood for refusal, one olive for funded, gold for
money. Display serif for headings, grotesk for UI, mono for every number, date and hash.
1px borders, offset shadows, no gradients, no glass, no emoji, no charts. Body contrast
at least 4.5:1; focus rings visible; 390px and 1440px both audited.

---

## 13. Security and privacy

- Sandbox only. The client refuses any non-sandbox base URL; a literal check in tests.
- No secret in the repo, the HTML, or the logs. `.env.example` lists names only.
- Webhooks verified before parsing state changes; unverified events stored and ignored.
- Uploads: size cap, MIME sniff, PDF/PNG/JPEG only, stored outside the web root, served
  through a route that checks the invoice id.
- No accounts in v1. The demo is sandbox data; the README says so. A public URL sets
  `DEMO_PASSWORD` and every route except `/health` then requires HTTP Basic. The username selects
  one of four identities (desk, seller, funder, debtor) and each identity may only call the routes on
  its own side of the trade — a seller cannot capture a funding order — so the demo shows role
  separation rather than a shared admin link. The password goes in the Devpost form. An empty
  password means localhost only, and the seeded database contains no real party.
- PII: sandbox identities only. No real seller, debtor or address in the repo or the video.
- Evidence: the raw run logs stay gitignored (`evidence/d0/`); a curated set (`evidence/published/`)
  is committed because it backs the measured claims and contains only sandbox ids and `@example.com`
  addresses.

---

## 14. Tests and acceptance

Unit, all offline. Current suite: 127 tests via `npm test`, 0 failures, 0 skipped. The reader
reconciliation
has its own file: agreement keeps confidence, a single-source field survives at 0.75 whichever
reader found it, a disagreement halves below the floor, a model outage keeps the parser's reason
verbatim, and the vision merge is tested with a fake transcription — including the case where the
field pass reports a tracking number its own transcription does not contain.

- Gate: each of the eleven checks passes and fails on a fixture; every refusal has a code,
  a rule sentence and an evidence region. The confidence floor has its own cases: a shaky delivery
  date, delivered flag, address or signature refuses the check that would otherwise pass on it, with
  the field, its percentage and the profile's floor named in the detail; a low-confidence *absence*
  keeps `NO_SIGNATURE_EVIDENCE` and a delivery photograph still verifies over it; and a tracker read
  below the floor is never quoted as unique by E06, which rests on the file hash instead.
- Intake (`tests/intake.test.ts`): the reuse checks against a real in-memory book — re-uploading the
  same bytes is refused `EVIDENCE_REUSED` and names the invoice already on file, without the UNIQUE
  sha256 column throwing; a new file carrying a tracker already on the book is refused
  `TRACKER_REUSED` after normalisation (`1z-999-aa1-0123-4567-84` is the parcel `1Z999AA10123456784`);
  a genuinely different parcel still prices; and a document with no readable tracker is checked by
  hash alone and says so.
- Gate purity: same input twice, deep-equal output; no filesystem or network import.
- Portability: one document, two profiles — the Royal Mail receipt verifies under GB; read with US tables
  the same bundle is refused on exactly `TRACKING_INVALID` and `ADDRESS_MISMATCH`, and a 120-day-tenor
  variant adds `TERMS_INVALID` while the US cap refuses it; name matching, arithmetic, hashes, the
  delivery window and the signature check never move. The printed rule sentence carries the deciding
  profile's own numbers in both directions.
- Score: pinned fixtures per band; component weights sum to 100; D refuses.
- Price: the worked example reproduces to the cent; integer arithmetic only; tenor caps.
- Ledger: every transaction balances; no negative balances; allocation sums to the capture.
- State machine: every illegal transition throws; refusal is terminal.
- Idempotency: duplicate webhook, duplicate capture, duplicate funding order, duplicate payout.
- Audit: one row per decision; no row without a subject; chain verifies; tampering breaks it.
- Schema (`tests/schema.test.ts`): a database file written before a column existed still opens — the
  column is added, the index on it is built afterwards, the pre-existing row survives with `NULL` in
  the new column, and reopening the upgraded file changes nothing.
- Notice: a partly bought invoice is not served; the stored bytes are the hashed bytes, once; an edit
  after issue is caught by the digest; the service register appends (never amends — the trigger throws),
  takes its digest from the stored notice rather than the form, refuses to certify a tampered notice,
  and exists only where a notice does. `serve notice` is a desk-only verb.
- Webhooks: each attribution path resolves; an event that names nothing resolves to nothing; a
  verified dispute freezes once; a resolution restores the prior status; settled is not freezable.
- Auth: no password configured allows everything; a configured password admits only itself, in
  constant time, and a malformed header never passes.
- Pages (`tests/pages.test.ts`, the first render tests): a priced invoice renders from stored rows; the
  service register appears only in the desk view and only once a notice exists; a collision refusal
  prints the invoice number it collided with in place of the bytes; and a recorded reader disagreement
  marks both values `<mark>`ed in the document. The two readings also render side by side — driven by a
  real `reconcile()` over the deterministic parser plus a model answer, so the shaded row is the field
  the stored readings split on, its halved confidence is the 45% the merge computed, and the invoice is
  refused `POD_UNREADABLE` for exactly that reason; a document only one reader saw prints no table.
- Secrets: scan the repo and rendered HTML for env values; must be zero hits.

Integration, measured by hand and recorded in `evidence/published/`:

- X1, X2, X4 re-run; X5's card path refused, so the funding beat ran on a real approval click.
- Full incident: refuse one invoice; verify one; fund a slice; capture; reconcile.
- Replay the same webhook twice; one allocation.
- Re-run funding; one order.
- Kill the AI key; the same invoice is refused, not allowed.

UI:

- 390px and 1440px screenshots; no horizontal scroll at 390.
- Contrast check; focus visible; print stylesheet for the receipt.
- Refused and funded states both reachable from fixtures without PayPal.

Acceptance, the seven that gate recording:

1. No invoice can be listed without all eleven checks passing.
2. Every refusal shows the failed rule and the evidence region.
3. Money is integer cents; every ledger transaction balances.
4. A slice cannot be funded twice; a settlement cannot be paid twice.
5. AI failure produces refusal, never approval.
6. No secret in the repo or on screen.
7. Fresh clone runs from the README; video under 3:00, public, no music or third-party marks.

---

## 15. The demo (under 3:00)

| t | On screen | Say |
|---|---|---|
| 0:00 | Refusal card, A-1043, $48,000, `CONSIGNEE_MISMATCH` | "Forty-eight thousand dollars, refused before funding. Here is the line that failed." |
| 0:08 | The POD document with the consignee boxed beside the debtor name | "The signature block names a different company than the invoice." |
| 0:16 | Scroll to the audit chain: extraction, gate, refusal, each with a hash | "No proof, no funding, and the refusal is on the record." |
| 0:24 | A-1051, "How the document was read": model id, six fields at 100%, the parser beside it | "Two readers open every document: a model and a label parser. Agreement keeps the confidence; disagreement halves it and refuses." |
| 0:38 | The eleven checks, all passed, then score 83 band B, 14.0%, $58.81 discount | "The debtor's own history prices it, not a model's opinion." |
| 0:50 | U-3827 waiting for approval; the funder approves one order in the sandbox; capture runs | "One order, two purchase units: the seller's advance and the platform fee are paid by the same capture." |
| 1:06 | Seller advance and platform fee, each with its capture id | "The money splits by ownership inside one payment. No platform balance is created." |
| 1:16 | NW-2277 showing **Due, awaiting debtor**, then the receipt with its two capture ids, labelled **sandbox replay** | "At maturity the debtor pays once, into one order of two purchase units: the funder's principal and yield, and the seller's remainder. PayPal takes its fee from each payee, not as a unit of its own." |
| 1:30 | A refund event resolves to its invoice; the position freezes with a reserve | "If the rail reports a refund, the position freezes itself." |
| 1:40 | MT-2207, the profile card: United Kingdom, Royal Mail believed, 60-day window, 120-day cap, Purchase Protection | "Same eleven checks, another country's numbers. A third market is a block of YAML, not a rewrite." |
| 1:50 | Archive: 625 of 1,005 refused, by reason; ledger balanced; chain verified | "One refusal, one funding, both provable on the page." |
| 2:00 | Final card: what this is not | "Not escrow, not a lender, not a marketplace. Sandbox only; no real money moves." |

Recording rules. Exactly one live capture in the take — the funding. The maturity beat is a
recorded capture replayed with "sandbox replay" on screen, because two live money beats in the
last thirty seconds is the one failure that cannot be edited out. The model beat must show a
document the model actually read (A-1051 in the shipped book); if the free reader's minute is
spent, the card says so on screen and the take uses the next available document after the window.
A timed dry run must finish under 2:10 before recording starts; if it does not, the dispute beat
is cut, never the refusal or the model card. No fake click, no music, no cuts.

---

## 16. Submission artefacts

- **README** opens with: newly built during the submission period; what it refuses; the
  settlement model and its boundary; how to run it with a sandbox app; the test commands.
- **LICENSE** MIT, visible in the repo About section.
- **Live demo URL** in the first paragraph of the Devpost text, pre-loaded with fixtures so a
  judge lands on a refused invoice and can click through to a settled one. A judge who clicks
  is worth more than a judge who watches.
- **Devpost text** opens with the refusal, not the architecture; names the seller, the
  funder, and the money at stake; states the sandbox boundary in the first paragraph; carries
  a short "what this is not" section — not a factoring marketplace, not a lender, not escrow,
  and the one sentence on why it cannot be rebuilt on Stripe (section 21, A6).
- **Video** public on YouTube, under 3:00, no music, no third-party marks.
- **Evidence pack** in the repo: the D0 experiment outputs, the pinned pricing fixture,
  and the ledger reconciliation output.
- **Synthetic dataset** in the repo: 1,000 generated invoices with POD documents, labels, and
  the refusal-code distribution, plus the golden fixtures every UI state is built from. It
  makes the refusal archive reproducible and gives a judge something to check.
- **One-pager** attached to the submission: what happens to $48,000 face, step by step, with
  the fee arithmetic and who bears what risk at each stage.

---

## 17. Schedule

| Date | Work | Exit check |
|---|---|---|
| 29 Oct | Plan approval; sandbox app; X1/X2 captures, X3 payout | **Met.** X1 and X2 captured; split confirmed on the payer ledger; X3 201; Architecture A selected |
| 30 Oct | X4 webhook against the deployed skeleton; US business account; PayPal client, schema | Live URL serves a page and verifies one real webhook |
| 31 Oct | Evidence upload, extraction, E00–E10 | Refused fixture renders with region |
| 1 Nov | Scorecard + pricing | Worked example reproduces to the cent |
| 2 Nov | Slices, commitments, funding order and capture | Funding idempotent; second attempt returns the same order |
| 3 Nov | Maturity payment, allocation, ledger, dataset generator | Balanced ledger; 1,000 invoices generate |
| 4 Nov | Deal room, the book, the refusal archive (counts read from data, never hard-coded) | Archive counts match the fixtures |
| 5 Nov | Ledger book, audit chain, role views | Balance assertion visible; chain verifies; roles switch |
| 6 Nov | Golden fixtures, late path, dispute freeze | Fixtures pin every screen; freeze blocks settlement |
| 7 Nov | End-to-end incidents and acceptance run | All acceptance tests pass |
| 8 Nov | README, licence, one-pager, Devpost draft | Fresh clone runs; URL live |
| 9 Nov | Record, two takes | Under 3:00, public, no marks or music |
| 10–12 Nov | Buffer | Re-run acceptance; fix, don't add |

The tail is optional and named: late path, dispute freeze, reconcile CLI, print stylesheet.
If day 6 is behind, those are cut, not compressed. Two people across the window; one builds
the gate and the money path, one builds the screens and the recording. The schedule is a
two-person schedule because the review said the one-person version is a two-week plan in one
week's clothes.

---

## 18. Risks and kill criteria

| Risk | Likelihood | Mitigation | Kill criterion |
|---|---|---|---|
| Multi-payee unsupported | Medium | Architecture B with Payouts and a stated boundary | If B also fails, stop |
| Payouts blocked in sandbox | Medium | Verify on day 0 | See above |
| Demo pacing | High | Pre-approved buyers; one invoice per beat; no UI tours | If a dry run exceeds 100s, cut the debt-side beat, not the refusal |
| 90-day tenor vs 60-day demo | — | Sandbox clock; maturity simulated by a labelled "advance to maturity" control | Never fake a payment date silently |
| AI misreads a document | Medium | Confidence thresholds; refusal on doubt; text-layer first | If refusal rate on clean fixtures > 20%, fix prompt before UI |
| Money transmission objection | Certain in production | Custody-free architecture where possible; explicit boundary otherwise | Do not claim escrow |
| Scope creep into collections | High | Late path is a status and a reminder only | No dialler, no legal workflow |
| Policy/trademark in video | Low | No carrier or bank marks; neutral UI | Re-record, don't blur |

---

## 19. Decisions

1. **Hosting.** Decided: yes, and it is an artefact, not an option. One service, SQLite on a
   persistent disk, fixtures pre-loaded, URL in the first paragraph of the Devpost text.
   Without a clickable URL the presentation criterion caps near the median.
2. **AG Grid.** Round 1 said keep it as a viewer on `/ledger`; the built ledger is a printed book
   of server-rendered tables, so the library was dropped (2026-10-30) rather than bolted on. The
   zero-balance assertion lives in SQL and a test, where it is a control instead of a decoration.
   Measured score effect: 0 either way. It is not a reason to pick this project and it is not a
   sponsor play.
3. **Model route.** Deterministic text extraction first and only, for the submission: the demo data
   is parsed without a model, and the optional second pass sits behind an OpenAI-compatible
   interface with no default endpoint. A model outage can only produce a refusal.
4. **Architecture.** Decided by D0, not by preference. Build for A, keep B behind the same
   settlement interface so a failed experiment is a config switch, not a rewrite. Both README
   branches are drafted before the results land.
5. **Repo name.** `discountwindow`. Licence MIT.
6. **Roles.** Decided by review round 1: three views behind one shared password. No user
   accounts. A two-sided market with one view reads as a demo.

---

## 20. Definition of done

- All seven acceptance tests pass on a fresh clone.
- A stranger explains a refusal in 15 seconds without prompting.
- Every displayed amount traces to a capture, a ledger entry, or a pinned fixture.
- No screen shows a number the system cannot prove.
- The video shows one refusal and one funding, live, under three minutes.
- The README states the settlement boundary before it states the features.

---

## 21. Review round 1 — findings, amendments, and what raises the ceiling

Status: reviewed 2026-10-29. Two models returned a complete review under a premise that
assumes every resource is provided. That premise is the right one: a rating that penalises
an unbuilt account is a rating of the reviewer's patience, not of the submission.

### Who reviewed

| Reviewer | As designed | Ceiling | Verdict |
|---|---|---|---|
| claude-opus-5.5 | 68 (13/14/12/15/14) | 88 (18/17/16/19/18) | GO_WITH_CHANGES |
| claude-fable-5-1 | 66 (14/14/12/13/13) | 82 (18/16/15/16/17) | GO_WITH_CHANGES |
| claude-sonnet-5 | did not return a usable review | — | excluded |

Both put the ceiling well above the current score and both locate the same four levers.

### Consensus

1. **The capture is unproven and it is the whole claim.** Creation of a two-payee order
   returned 201; the capture has not run. Both reviewers rank a saved capture response as the
   single highest-leverage artefact in the submission.
2. **There is no live demo URL in the deliverable list.** Both rank a clickable hosted demo as
   worth about five presentation points and neither thinks anything else fixes it.
3. **Refusals should be countable.** Both propose a public refusal record so that impact is a
   number a judge can quote, not an adjective.
4. **AG Grid is not a scoring lever.** Both put the delta at roughly zero in either direction
   and both say the zero-balance assertion belongs in the data layer, not the grid.

### Disagreement, and how it was decided

| Point | Opus | Fable | Decision and reason |
|---|---|---|---|
| AG Grid | genuine, keep | decorative, keep or replace | Keep, viewer only, Community edition, assertion in SQL. Both agree the score effect is zero, so legibility breaks the tie. It is not a sponsor play. |
| Role views | needed, +4 design | silent | Adopt. One view makes a two-sided market read as a demo. |
| Stripe as a second rail | +3 | not raised | Reject. It dilutes the PayPal application the event is actually scoring. |
| AI produces the score | not raised | +3, but conflicts with the fence | Reject. The AI flags and extracts; it never decides or prices. |
| Hosted URL | +5 presentation | +5 presentation | Adopt, both peers agree. |

### Amendments applied

- **A1 — Hosted demo is an artefact.** URL in the first paragraph of the Devpost text, fixtures
  pre-loaded, a judge lands on a refused invoice. Sections 16, 19.1.
- **A2 — Capture proof gates the build.** X2 capture and X5 run before product code, both
  results committed. Both README branches drafted in advance so a failed X2 is a documented
  choice, not a surprise. Sections 4, 0.
- **A3 — `/archive`, the refusal archive.** Codes, counts, document regions. Section 12.
- **A4 — Roles.** Seller, funder, desk, behind one shared password. Section 12, 19.6.
- **A5 — Synthetic dataset and golden fixtures.** 1,000 generated invoices with PODs, labels,
  and the refusal distribution. Section 16.
- **A6 — PayPal-native evidence, and the answer to "why not Stripe".** Below.
- **A7 — The demo opens on the refusal and closes on the chain.** Section 15.
- **A8 — AG Grid demoted to a viewer.** Section 12, 19.2.
- **A9 — The requirements list is in the plan.** Below.
- **A10 — One-pager and "what this is not".** Section 16.
- **A11 — Schedule re-baselined** to two people across the full 14 days, with the tail
  (late path, dispute freeze, reconcile CLI) explicitly optional.

### A6 — why this cannot be rebuilt on Stripe

The gate does not read a PDF and trust it. It reads PayPal's own protection record: Add
Tracking binds a delivery to a specific transaction, and the Seller Protection rules turn
that into an eligibility status the platform can query. The funder underwrites against a
status issued by the payment rail, not against a document the seller printed.

That is the difference. Remove PayPal and the evidence source collapses to a PDF any seller
can fake, which is exactly the risk the product exists to price. It is the test the whole
board has to pass: remove the sponsor's product and the output should collapse. This is the
only version of the idea that passes it.

Implementation: one more gate input, `protection_status`, read from the transaction and
tracker and checked as E00 before the document checks run. If the underlying transaction is not Seller-Protection
eligible, the invoice is refused with `PROTECTION_INELIGIBLE` regardless of how clean the
paperwork looks. The AI still only extracts; the status is a fact from the rail.

This is buildable, not aspirational: the capture resource carries `seller_protection.status`
and `dispute_categories` (verified 2026-10-29), and Add Tracking binds a tracker to a
transaction id. What it requires is that the seller's original sale ran through the platform,
so the transaction id is ours to read. That constraint is the point — it is what makes the
product PayPal-shaped rather than rail-agnostic.

The fee path needs the same honesty: `seller_receivable_breakdown` is absent from some
capture responses, so the actual fee is read from the transactions reporting API when the
capture omits it, and the receipt states which source it used. No silent estimate.

### The requirements to execute

| Item | Why | Time | Cost |
|---|---|---|---|
| US-country sandbox business account, new app | Measured: the NG merchant answers `PAYEE_ACCOUNT_LOCKED_OR_CLOSED` to every buyer checkout and 422 to card capture. Until one exists, E00 runs under the labelled sandbox override | 1 h | $0 |
| Two sandbox personal accounts with known passwords | Buyer-side approval for funding and maturity captures. Provisioning by script works, but Adaptive Accounts does not set a password, so the dashboard path is the only way to get accounts the operator can drive | 1 h | $0 |
| Test cards and balances on both buyers | Live capture on camera | 0.5 h | $0 |
| Public webhook endpoint (host or tunnel) | X4 and every state transition | 1 h | $0 |
| Hosting with a persistent disk | The live URL is an artefact | 1 h | $0 |
| Domain + TLS | Clean link in the write-up | 0.5 h | ~$12/yr |
| Gemini key + one fallback OpenAI-compatible key | AI is a Stage One requirement | 0.5 h | $0 |
| GitHub public repo, MIT in About | Submission requirement | 0.5 h | $0 |
| YouTube channel, public upload | Submission requirement | 0.5 h | $0 |
| Second person for recording | Two live capture beats, one operator | 3 h | $0 |
| AG Grid Community | Ledger viewer — **dropped 2026-10-30**, see §19.2 | 0 h | $0 |

### What takes this to 90+

| Change | Points | On which criterion |
|---|---|---|
| Proven capture, both buyers, saved responses in the evidence pack | +5 | Technological Implementation |
| Live hosted demo with pre-loaded fixtures, URL first | +5 | Presentation |
| Refusal archive with real counts | +4 | Potential Impact |
| Role views | +4 | Design |
| A6, protection status as a gate input | +4 | Innovation |
| Demo opens on the refusal, closes on the chain | +4 | Presentation |
| Synthetic dataset in the repo | +3 | Potential Impact |
| One-pager and "what this is not" | +2 | Innovation |

Sum of the named changes: 31 points against a 68 baseline, discounted for overlap and for
the fact that no reviewer credits all of them at once. The honest target is 90-93, not 98:
both reviewers cap the ceiling below 90 without the capture proof, and neither will go past
94 without a named pilot or partner, which this build does not have.

### Round 2 — re-review after the amendments

| Reviewer | Round 1 | Round 2 | Ceiling |
|---|---|---|---|
| claude-opus-5.5 | 68 | **79** (15/16/14/17/17) | **92** |
| claude-fable-5-1 | 66 | **77** (15/16/14/16/16) | **90** |

Both moved, neither moved as far as the amendments were meant to take it, and both name the
same reason: the capture has still not been run. That is correct. A gate that promises a test
is not a test. The score cannot rise until the capture response exists.

**Resolved by both:** AG Grid (delta 0, viewer-only accepted), role views, the hosted URL, and
the custody disclosure.

**A6, the rail-issued gate input:** both call it real and both name the same failure from
opposite sides. Opus: an invoice whose original sale did not run through the platform has no
transaction to read. Fable: a sandbox capture may return `PARTIALLY_ELIGIBLE`, so E00 would
refuse the demo's own invoices. Same root: eligibility is a fact about a transaction, and the
demo must own the transaction before it can read it.

**Still unresolved after both rounds:** the capture proof (both) and the recording's pacing
(Fable). These are the only two items standing between 79 and the low nineties.

### Round 2 amendments

- **A12 — E00 sandbox override, labelled and chained.** If a sandbox capture returns a
  non-eligible status for a fixture that would be eligible in production, the demo says so on
  screen, says so in the README, and writes the override to the audit chain. Section 8.
- **A13 — one live capture, not two.** The funding capture is live; the maturity capture is a
  labelled replay. Two live money beats in the last thirty seconds is the one failure a solo
  recording cannot recover from. Section 15.
- **A14 — dataset before the archive.** Generated 3 Nov; the archive reads counts from data and
  never hard-codes them. Sections 12, 17.
- **A15 — the demo opens in the funder view.** The role switch then reads as a journey through
  the market, not as a password toggle. Section 12.
- **A16 — sale creation and Add Tracking are fixture setup.** Every fixture invoice owns a
  PayPal transaction with a tracker, created by script, so E00 always has something to read.
  This adds one requirement row and one step to the demo's pre-roll, not to the 90 seconds.

### Where the score actually is

79 as designed, 90–92 at the ceiling if A12–A16 land and the two captures run. The gap between
79 and 92 is, precisely: one saved capture response, one dry run under 100 seconds, and the
five amendments above. Nothing in that list requires a new idea, a new sponsor, or a partner.

### Round 3 — final vote

Four judges, two model families, one question: should code start.

| Judge | Family | Final score | Build now |
|---|---|---|---|
| claude-opus-5.5 | Anthropic | 81 (16/16/14/18/17), ceiling 92 | yes |
| claude-fable-5-1 | Anthropic | 77 (round 2), no round-3 return | yes |
| gpt-oss-120b | OpenAI | 77 | yes |
| gemini-3.8-flash | Google | 80 | yes |

Mean 78.75. Ceiling 90–92. **Unanimous: build.** No dissent on the decision, only on the
number.

Every judge named the same weakest point in different words: the capture is built but not
proven. Opus made it a date and a fallback — save the two-payee capture response by 2 Nov, or
commit the custody branch. That is now the gate on the critical path.

Every judge independently rejected the "could this be Stripe?" objection, each citing the
Seller Protection gate as the reason it cannot port. That is the answer to the theme-fit risk,
arrived at without being asked twice.

### A17 — the dispute freeze, and why it went in after the vote

Gemini proposed the one upgrade neither Anthropic reviewer found: read PayPal's Disputes API
as a live risk oracle, not just an origination check. `CUSTOMER.DISPUTE.CREATED` arrives on a
webhook, the receivable freezes, the ledger stops allocating, the funder's position shows a
reserve, and the audit chain records why. `CUSTOMER.DISPUTE.RESOLVED` thaws it.

Why it matters more than it costs: A6 proves the receivable was protected **at origination**.
Protection status can change during the tenor, and a static check cannot see that. The
dispute freeze is what makes the rail-issued-facts story true for the whole life of the
position instead of its first day. It is roughly half a day, it reuses the `disputed` state,
the `webhook_events` table and the audit chain that already exist, and it adds no UI beyond a
badge and a frozen row.

Scope guard: notification and freeze only. No dispute-response workflow, no evidence
submission, no chargeback rebuttal. If it grows past a webhook handler and a state
transition, it has become a different product and is cut.

### The record, if a judge asks how this was decided

Three rounds, four models, two families. Amended five times on round 1, five on round 2, once
after round 3. Every amendment names the objection that caused it. The disputed points
(AG Grid, role views, a Stripe rail, AI-produced scoring) are recorded with the reason each
was decided the way it was, not silently dropped. Nothing in the plan claims a PayPal
capability that was not either run against the sandbox or read from the API reference on the
date shown.

---

## 22. Review round 4 — the measured re-score

The round-3 number was a projection: every judge scored an architecture that had been designed but
not captured. On 30 October the two-payee and three-payee captures were run and saved, including a
payer-ledger confirmation that money left one account for two, then three. The same brief was put
back to two judges with one question: does the number move, and does the ceiling hold.

| Judge | Round 3 | Round 4 | Ceiling | Verdict |
|---|---|---|---|---|
| claude-opus-5.5 | 81 | **86** | 94 | hold A, build |
| gemini-3.8-flash | 80 | **84** | 93 | hold A, build |

Per-criterion movement, both judges:

| Criterion | Opus | Gemini | Driver named |
|---|---|---|---|
| Technological Implementation | 16 → 18 | 16 → 18 | The saved split capture, plus the `capture.payee` quirk handled and tested |
| Design | 16 → 16 | 16 → 16 | Nothing measured touches the screens; they are still unbuilt |
| Potential Impact | 14 → 15 | 14 → 15 | Custody-free is measured, so the licensing prerequisite disappears |
| Innovation | 18 → 19 | 18 → 18 | Opus: the architecture is now a demonstrated fact, not a hypothesis |
| Presentation | 17 → 18 | 17 → 17 | Opus: the maturity beat now has a saved response to replay |
| **Total** | **81 → 86** | **80 → 84** | |

Both said 90+ is reachable and both said it is not reached by anything in the evidence pack. The
distance is the build itself: the ledger, the screens, the dataset, the webhook, the take. That is
the correct answer, and it is the reason development starts now rather than after another review.

New risks both judges raised, and what the build does about each:

| Risk | Severity | Response |
|---|---|---|
| Every measured capture is PENDING because the buyer funded by bank | Medium | The receipt screen states the settlement state and why. A card-funded capture becomes the demo take once the US merchant exists |
| `seller_protection` is NOT_ELIGIBLE on personal accounts, so E00 would refuse everything | Medium | The override is shown beside the raw status, written to the audit chain, and cannot be enabled on any non-sandbox base URL |
| An NG-country merchant cannot receive at all | High | This is a provisioning item with a measured error code, not an open question |
| Any future code path reading `capture.payee` silently misallocates | High | Allocation lives in one function and reads the order's purchase units; `tests/allocate.test.ts` pins the case where the capture response and the order disagree. There is no CI in this build, so the enforcement is the test, not a pipeline |

One amendment accepted from round 4, from Gemini: the ledger must handle a missing
`seller_receivable_breakdown` by posting the reserved fee and reconciling the difference to
`platform:fee_variance` when the amount is known. The plan already said the fee is not always
returned; it did not say what the posting does in that case. It does now.

---

## 23. Review round 5 — the built desk, scored

Round 4 scored an architecture with captures attached. This round scored the running app: the README,
DEVPOST, the gate and its rules, the ledger, the extraction layer, the webhook handler, the tests and
the committed evidence were put in front of two judges with the Devpost criteria named, and both were
asked to assume every artefact they mention can be provided.

| Judge | Family | First pass | After the build list | Weakest axis named |
|---|---|---|---|---|
| nemotron-3-ultra-550b | NVIDIA | 87 (18/16/17/17/19) | **91** (18/19/17/18/19) | Potential Impact |
| gemini-3.8-flash-free | Google | — | **91** (19/17/19/17/19) | Innovation — "AI positioning within an AI hackathon" |

Both passed Stage One unprompted. `claude-opus-5` was rate-limited (429 with a window) and the ZenMux
route returned 402 `insufficient_credits`, so the round rests on two voices rather than three.

**Nemotron's five fix-first items, and what became of each.**

1. *Public demo and recorded video.* Open. Nothing about the build is blocked by it; it is the last
   step before submission (section 15, `VIDEO.md`).
2. *A carrier API behind E02.* **Declined, deliberately.** A live carrier query would make E02 a
   stronger claim, but it needs a per-carrier contract, an outbound key, and a cache with its own
   failure modes — and this build already states on the page, in the README and in the check's own
   rule sentence that it validates a format and does not query the carrier, with E03/E04/E05/E10
   required to corroborate the same document. Trading a stated limit for a partially-covered truth
   (one carrier of five, trial key, no SLA) does not make the desk more honest, and it is the same
   mistake as bolting on a sponsor to buy a point.
3. *Vision/OCR pre-pass.* **Built and measured** on 2026-10-30: a photographed receipt with no text
   layer is transcribed by the model, the label parser reads the transcription, the two are
   reconciled, and the invoice verifies and prices. `evidence/published/x6-vision-read.json`.
4. *UK jurisdiction config.* **Built and measured** the same day: `rules/jurisdictions.yaml`, two
   profiles, one document decided under both. Section 8, `tests/jurisdiction.test.ts`,
   `evidence/published/x7-jurisdiction-profiles.json`.
5. *A real refund webhook.* **Not reachable, and now recorded as a measured fact** rather than an
   open claim: every capture this sandbox has ever produced is `PENDING` (bank/eCheck funding) and
   the Refunds API reverses only `COMPLETED` captures. Eight capture ids probed on 2026-10-30;
   `refundable = false` on all of them. The dispute and refund branches stay signed-sample plus
   tests, labelled as such wherever they appear.

**Gemini's four, and the answers.** Promote the model from optional to primary: the model is already
the only reader a photograph has, and the deal room says which reader produced each field — the
reason it is fenced rather than free is the reconciliation table, not caution. The B2B-versus-Seller-
Protection premise: answered in DEVPOST by naming the buyer this rail actually sees (a contractor or
retail chain already paying from a wallet). E02 beyond regex: declined for the reason above. Hostile
cases: the first-word-subset consignee rule, single-source confidence at 0.75, an invented tracking
number that its own transcription does not contain, and a stale-model outage are all in the tests.

**What this round caught, and what was corrected.**

- Two claims were *unverifiable* because the brief omitted the files: the hash-chained audit walk
  (`src/audit.ts`) and webhook verification before state change (`src/paypal.ts`). Both are real and
  tested; the omission was the brief's. Next round ships with those two files named and included.
- One claim was stale: round 4's response table said "a grep check in CI". There is no CI in this
  build. The enforcement is `tests/allocate.test.ts` and the fact that allocation reads the order's
  purchase units and never `capture.payee`. The row now says that.
- Two refusals the judges read as overstatement: the dispute branch (see item 5) and the platform as
  a payee. Both are already labelled on screen and in the README; the wording around the second was
  tightened rather than widened.

**The remaining distance, named.** The two judges agree on what separates 91 from the high nineties,
and none of it is a new idea: the demo URL and the video (Presentation), one live carrier truth
(declined, above), a second country already shipped (done), and the model's cadence being a free tier
rather than a funded route (a key, not a design change). The build list is finished; the next two
rounds are the fresh-eyes test of that claim.

---

## 24. Review round 6 — the loss side, scored

Round 5 scored the desk with the vision pass and the second country attached. Round 6 scored the same
desk and found the half of it that had not been built: nothing in the book described the day the
debtor does not pay. The two judges were given the Devpost criteria, told to assume any artefact they
ask for can be provided, and asked to **exercise abstract thinking** about the hostile seller, the
different jurisdiction, and the trade that goes wrong.

| Judge | Family | Brief size | Score | T/I · D · PI · In · Pr | Weakest axis |
|---|---|---|---|---|---|
| nemotron-3-ultra-550b | NVIDIA | verdict cut (~9.4k tok) | **96** (19/20/18/20/19) | Potential Impact | "the design cannot serve large shippers on ACH/ERP rails, capping TAM" |
| gemini-3.8-flash-free | Google | full (~30k tok) | **92** (19/19/16/19/19) | Potential Impact | "debtor default is unaddressed" |

Both passed Stage One unprompted. The four-point gap between them is worth naming plainly: nemotron
read the short brief. Its 96 is a score on less material, and round 7 gives it the full one — which
is the only way to find out whether the gap is the model or the packet.

**Gemini's three fix-first items. All three are now built and measured.**

1. *Recourse and a default state machine* (+3, Impact & Design). **Built.** A term chosen at intake —
   `recourse`, or relief from it for 4.00% a year, refused outright on band C — then `funded → overdue
   → defaulted → repurchased | uncollectible`, the grace days read from the debtor's jurisdiction
   profile, and the three closing verbs held by the desk alone. Recourse posts **nothing** at default:
   a promise to repurchase is not an asset. Two partial repurchases accumulate against each funder's
   unpaid remainder — a bug the accumulation test found and fixed, because the first version measured
   every part against the original outlay and would have let two partials pay the same cents twice.
   `tests/default.test.ts`, `tests/auth.test.ts`,
   [`evidence/published/x8-default-recourse-chain.json`](evidence/published/x8-default-recourse-chain.json),
   README "When the debtor does not pay", DEVPOST "The loss side".
2. *Notice of assignment* (+2, Impact). **Built.** When the last slice of an invoice is captured the
   desk generates the document from stored rows only — no model touches it — stores the bytes, hashes
   them into the audit chain, and serves them unmodified so anyone can re-hash what was signed. It is
   issued only when the paper is owned outright, because a partly assigned receivable tells the debtor
   something untrue. What the build does *not* claim is service: UCC 9-406 and LPA 1925 s.136 are now
   named in `notModelled` in both profiles. `src/notice.ts`, `tests/notice.test.ts`, README "The notice
   of assignment".
3. *The Commerce Platform prerequisite for split capture* (+1, Tech). **Built as documentation, which
   is what it needed.** The README now says the order whose purchase units each name a different payee
   is not a checkout but a marketplace payout, that PayPal reserves it to accounts onboarded through
   the partner flow, and that the sandbox accepts it while production would not.

**The two objections round 6 left open, and how they are answered now.**

- *Who absorbs a chargeback clawback, when freezing is not reversing.* True of the round-6 build: the
  freeze stopped new operations and nothing described the money leaving. It now does, and the answer is
  that a reversal and a non-payment are the same ending reached from different directions — the
  funder's position reopens and the term picked at intake says whose loss it is, collected through the
  `repurchase` posting, which records an amount and never asks the channel (a PayPal payment, a wire,
  the next invoice paid short). The desk does not net a clawback against a balance it does not hold, and
  it does not decide a dispute it cannot observe: no refund or reversal has ever executed here, because
  every capture this sandbox produces is `PENDING`.
- *An empty tracked envelope satisfies E02–E05 and E10.* Also true, and now stated as the hostile case
  the desk cannot read away rather than left for a judge to find. No check weighs a pallet, because a
  manifest gross weight is the carrier's data and no carrier is queried — the same declined dependency
  as round 5's item 2, now named in `notModelled` in both profiles. The build's answer is the shape of
  the trade: a hollow shipment has to be aimed at a named debtor that will refuse to pay, the refusal
  lands in the default machine, that debtor's history is what set the band, and the relief from
  recourse a phantom shipment feeds on costs 4.00% a year and is refused on band C paper. Fraud is
  priced as credit risk, not waved away by a twelfth check.

**What round 6 caught that was simply wrong.** Three things, each real:

- DEVPOST described the maturity beat as "one order, three purchase units at 20/30/50". The live
  experiment did settle three units to three accounts; the *application* sends two (funder, seller) and
  stores two columns, because PayPal takes its fee from each payee rather than as a unit of its own.
  Corrected in DEVPOST, in this file's section 0, and in the video script line that would have said it
  out loud on camera.
- "The client refuses to start against anything but the sandbox host — a literal check" had no test
  and no source in the brief. `src/config.ts` is now in the brief and the guard has
  `tests/config.test.ts` behind it.
- The E00 paragraph still implied freight invoices routinely arrive with a PayPal capture behind them.
  They usually do not: the payment to the platform is often the first thing the rail ever sees. That is
  why E00 has three answers, and why `NOT_ON_RAIL` demotes the band instead of refusing.

**Declined, with the reason.** A live carrier/manifest lookup (a per-carrier contract, an outbound key
and a cache with its own failure modes, in exchange for a partially-covered truth); and a mocked
ACH/Hyperwallet rail adapter — a second settlement path demonstrated by pretending is the one thing
this submission has spent six rounds arguing against, and the non-custodial invariant it would "prove"
is already stated in the text as a property of multi-payee settlement that does **not** travel.

**The suite moved from 91 to 102 tests** with the default lifecycle, the notice, the host guard and
the role of the loss side, all offline; the lifecycle and the notice are additionally proven over HTTP
against a spawned server, including a 403 when a funder presses `default`, a 409 when a repurchase
would overpay a claim, and `unbalanced_transactions: []` at every stage.

## 25. Review round 7 — the packet as it stood, scored

The brief this time was the whole submitted artefact: README, DEVPOST, the rules as data, the gate, the
extraction layer, the notice and its register, the loss lifecycle, the tests and the committed sandbox
evidence. Both judges were told to assume anything the packet says can be provided is provided, and to
score the submission rather than the repository, and both were asked to exercise abstract thinking about
what a receivables desk actually needs.

| Judge | Family | Score | Breakdown (TI/D/PI/Inn/Pres) | Weakest axis named |
|---|---|---|---|---|
| nemotron-3-ultra-550b | NVIDIA | **94** | 20/19/19/20/16 | Presentation — "the judge cannot click the demo, watch the video, or verify the hosted instance" |
| gemini-3.8-flash-free | Google | **91** | 19/18/16/19/19 | Potential Impact — the wallet-rail addressable market |

`claude-opus-5` again returned no route this side of its free window, so the round is two voices.

**What round 7 asked for, and where each item went.**

1. *Live demo URL and the shared password in the notes* (nemotron, +4 Presentation) — **open**, and the
   only genuinely open item in the round: it is the publish step, which needs a host and the user's go.
2. *Hosted sub-three-minute walkthrough* (nemotron, +3) — open, scripted in `VIDEO.md`, same gate.
3. *A `service_attempts` table and a desk-only "record service" button* (nemotron, +1 Design) —
   **already built** between round 6 and round 7 as the notice service register; round 7's packet
   predated it in the judge's reading, so it is now cited by name in README and DEVPOST.
4. *Optional `manifest_weight_cents` with a non-blocking E11* (nemotron, +1 Impact) — **declined**. A
   field the desk cannot obtain, recorded as absent, is a checkbox dressed as a control; the gap is
   already named in both `notModelled` lists and priced through the recourse term.
5. *Currency in the jurisdiction profile instead of hardcoded USD* (gemini, +3) — **declined for this
   build, costed at ≈6 h** and listed as the largest remaining honest gap. A GBP ledger is not a config
   change: it touches every amount in `price.ts`, `ledger.ts` and the purchase-unit builder, and the FX
   spread it would avoid is real but belongs in the `notModelled` list rather than half-done.
6. *Carrier scan verification behind E02* (gemini, +2) — **declined**, same reason as rounds 5 and 6.
7. *Idempotent state transitions for redelivered webhooks* (gemini, +2) — **already enforced**: the
   freeze and release paths refuse to move a position that is already in the target state, tested in
   `tests/dispute.test.ts` ("a second dispute is a no-op", "a settled invoice has nothing left to
   freeze"). Round 8 asked for the same thing again, which is evidence the packet did not say it clearly
   enough, so the README now names it.
8. *Side-by-side reader diff in the deal room* (gemini, +1) — **built and measured after round 7**, with
   the split field shaded and the used value beside it (`tests/pages.test.ts`).
9. *One-click identity switching on the demo* (gemini, +1) — open, and deliberately not done as a
   `?role=` query parameter: the username in HTTP Basic is the credential, and letting a query string
   override it would let a funder press the desk's buttons. A hash-based client-side switch inside an
   authenticated session is the version worth 3 h (see round 8).

## 26. Review round 8 — the rebuilt desk, scored

Round 8 sent the packet again after the reader diff table, the notice rail-status paragraph, the deleted
Payouts code, the refusal-count correction and the confidence-floor ratchet had landed.

| Judge | Family | Score | Breakdown | Weakest axis named |
|---|---|---|---|---|
| nemotron-3-ultra-550b | NVIDIA | **94** | 20/19/19/20/16 | Potential Impact — only `PENDING` sandbox captures, so the fee-estimate and reversal paths are unexercised against live money |
| gemini-3.8-flash-free | Google | **93** | 19/19/16/19/20 | Potential Impact — the addressable market of a wallet-rail desk |

Neither judge found a new architectural objection; both concentrated their remaining points on the same
two things, which is the useful signal of a converging review: the money path has never been demonstrated
`COMPLETED`, and the demo is not clickable from the packet.

**The five fix-first items round 8 named, and their disposition.**

| Item | Cost | Disposition |
|---|---|---|
| A US business sandbox merchant that accepts card funding so captures reach `COMPLETED` | 4 h | **Outside this build's control.** Measured across the whole sandbox history: every capture this app has produced is `PENDING` and `refundable = false`; card funding of a multi-payee order is refused at authorisation. The remaining path is PayPal partner onboarding, not code. |
| Client-side role switch so the four viewpoints do not reload | 3 h | **Built as a server-rendered lens, 2026-10-30 — section 28.** The client-side half was the wrong shape: the identity is the Basic username, so a switch can only re-render, never re-authorise. What shipped separates the two explicitly. |
| `COMPLETED` capture, reversal webhook and dispute-release fixtures in `evidence/published/` | 2 h | Blocked by the row above; the fixtures that can be produced offline already exist as signed sample plus tests and are labelled as such. |
| **A second independent vision reader for photographed documents** | 3 h | **Built and measured, 2026-10-30 — section 27.** |
| `servedAt` index and CSV export of the notice service register | 1 h | **Built and measured, 2026-10-30 — section 28**, with the digest re-verified per row and spreadsheet formula injection neutralised. |

Round 8 also listed four claims it wanted restated more plainly. All four were acted on rather than
argued: the dead `createPayout()` is deleted (a payout implies a platform balance, which the
non-custodial design forbids, so it was code that contradicted the text); the refusal breakdown now
reads `NOT_DELIVERED (26), DELIVERY_DATE_OUT_OF_WINDOW (26)`; the notice says the capture was *recorded*
and carries the rail's own status for it; and the model-scope sentence says the model is sent the
document and nothing else, instead of implying it sees nothing.

## 27. Two readers of the same photograph

Both round-8 judges named the same limit: a photographed proof of delivery had one reader of its pixels,
and the deterministic parser that corroborated it was reading that reader's own transcription. The parser
could catch a model mapping a label to the wrong value; it could not catch a model inventing a value that
was never on the paper but happened to survive its own transcription. The fix is a second model, and the
second model is on a key this project already holds.

**Measured, 2026-10-30, NVIDIA vision catalogue on the existing key** (one image,
`chat_template_kwargs.enable_thinking:false` where the route needs it):

| Model | Result |
|---|---|
| `meta/llama-3.2-11b-vision-instruct` | HTTP 404 — not entitled on this key |
| `nvidia/neva-22b` | HTTP 404 — not entitled |
| `microsoft/phi-3-vision-128k-instruct` | HTTP 404 — not entitled |
| `meta/llama-3.2-90b-vision-instruct` | HTTP 200 in 186 s — usable, far too slow for an intake form |
| **`nvidia/nemotron-3.5-super-vl-120b-a12b`** | **HTTP 200 in 3.7 s with thinking off — the reader this build uses** |

The second reader is configured the same way the first is — `EXTRACT_B_BASE_URL`, `EXTRACT_B_API_KEY`,
`EXTRACT_B_MODEL` — and the app is unchanged if it is absent: a photograph gets one read, and the page
and the notes both say so.

**What the pipeline now does.** `extractImageEvidence` asks both models the same question of the same
bytes. Their answers go through the existing three-case rule (`mergeReadings`), and the result goes
through it again against the label parser reading the first model's transcription. Each field carries
the worst verdict any comparison gave it (`Extraction.verdicts`), which is the part that matters: with a
plain `max` the second comparison could lift a field the pixel readers split on back over the floor, so
a disagreement about the photograph could be laundered by agreeing with one of the two transcriptions.
The floor is now applied to each comparison in turn and the lowest verdict stands. `mergeVisionRead`
keeps both readers' raw answers in `raw.model.pixels`, so the deal room prints one column per reader
rather than a prose note about a comparison nobody can see.

**Measured end to end** (`scripts/d0-two-readers.ts`, `evidence/published/x9-two-reader-vision.json`,
page bytes at `x9-two-reader-deal-room.html`): the committed receipt `x6-scanned-pod.jpg` — SHA-256
`45e270e4…16e9fd`, 195,293 bytes, no text layer — uploaded through the running app's own `/submit` form
on a scratch book, read by `gemini-3.8-flash-free` (BeatAPI) and
`nvidia/nemotron-3.5-super-vl-120b-a12b` (NVIDIA). Both returned `774120098780`, `Halcyon Retail Group`,
`2026-10-27`, the Austin address, signature present, delivered — each at 100% self-reported — and the
label parser over the first transcription agreed with all six fields. The invoice priced. The two calls
together took 39.7 s; the free tier's one-request-a-minute window applies to the primary reader only, so
the second costs the desk nothing in cadence. A second photograph
(`x9-scanned-pod-1053.jpg`, tracking `774120098772`) gave the same unanimous three-reader result.

**The disagreement path is proven by test, not by the photograph.** Two independent models handed the
same JPEG answered identically, which is the outcome the design wants; it is not a demonstration of the
ratchet. `tests/extract.test.ts` and `tests/pages.test.ts` construct the split explicitly: reader A says
`Halcyon Retail`, reader B says `Halcyon Retail Group`, the pixel comparison halves it to 0.45, the
parser comparison halves it again to 0.225 and the retained verdict stops the parser's 0.95 from lifting
it, so the field reads 23% on the page, the row is shaded, and the invoice is refused `POD_UNREADABLE`.
That is the case a single pixel reader could not produce: before this change, one model's word plus the
parser's agreement was enough to clear the floor.

## 28. Round 8 closed: the lens is not the authority (2026-10-30)

Two judges kept arriving at the same sentence from different directions: *a reviewer has to log out to
see the other side of the trade.* That is a presentation cost, but the fix had a trap in it. The naive
change — let `?view=` decide what works — would have made the page's own buttons a function of a query
string, which is exactly the thing this build refuses everywhere else: the display asserting a
permission it did not check.

So the two questions were separated in the code rather than in the prose.

- **The lens** (`view=desk|seller|funder`) is now open to every signed-in name. A funder can read what
  the seller was told; a seller can read the funder's yield. One login, three sides.
- **The authority** stays where it always was: `roleAllows(identity.role, verb)` against the Basic
  username, applied by `deny()` on every mutating route, unchanged by this work.
- **A button the viewer cannot press is not rendered.** `fundAction` and `maturityAction` take the
  identity now, and where the lens offers a step the name does not hold, the page prints who holds it,
  read from the same `MAY` table through the new `holdersOf(verb)` — so the sentence cannot drift from
  the rule it describes. A dead button that answers 403 teaches the reader nothing.
- **The desk's notebook stayed home.** The service register had been gated on the lens; that was
  almost right and entirely wrong — a log of who served what belongs to the desk, not to whoever is
  reading the desk's page. It now requires both the desk lens and the desk name.

Measured on a scratch book with `DEMO_PASSWORD` set, invoice A-1042 priced:

| Signed in as | Lens | Fund button | Note instead |
|---|---|---|---|
| `seller` | desk | absent | "Fund is pressed by **desk** or **funder** — not by **seller**" |
| `funder` | desk | present | — |
| `desk` | desk | present | — |
| `debtor` | desk | absent | same sentence, naming debtor |

`POST /invoices/A-1042/fund` as `seller` returned 403 with the identity named on the page — the lens
changed the reading, not the writing. `GET /notices/register.csv` returned 403 for `seller` and 200 for
`desk`. Three rendered pages are kept in `evidence/published/x10-lens-*.html`, each scanned for the
scratch password before publication (clean).

The pointer click itself is not in that evidence: the in-app browser has no attachable viewport this
session, so the lens links were loaded by their exact `href` rather than clicked. The hrefs are visible
in the accessibility snapshot, which makes the two equivalent for a server-rendered page; the claim is
stated that way rather than smoothed over.

Also closed from round 8, both documentation-only:

- **The Payouts API is unused, and that is now a measured decision rather than an omission.** The
  sandbox accepted it — HTTP 201, batch `MMXFLV6EUC89Y`, `PENDING` — and the product calls it nowhere,
  because paying parties out of a balance the desk holds is the shape that makes a desk a money
  transmitter. README and DEVPOST say so with the batch id attached.
- **The whole-book service register is documented as an endpoint** (`GET /notices/register.csv`), with
  the recomputed digest per row and the formula-injection guard, in the submission text and not only in
  the code.

Suite: **141 tests**, all offline. The two new ones are the lens table above and the register gate, so
a future change that re-couples viewpoint to authority fails rather than silently degrades.

## 29. Round 9, first voice: nemotron reads the lens (2026-10-30)

| Judge | Family | Score | Breakdown (TI/D/PI/Inn/Pres) | Weakest axis |
|---|---|---|---|---|
| nemotron-3-ultra-550b | NVIDIA | **94** | 19/19/18/19/19 | Potential Impact — Commerce Platform onboarding is a real go-to-market gate the sandbox hides |

Presentation moved **16 → 19** on the strength of the artefacts rather than the code: the register CSV,
the two-reader JSON, the three rendered lens pages, the counted refusals. The remaining point is the
hosted URL and the recording, both of which are outside the repository. Gemini timed out twice at the
front of this round (`503 upstream_timeout` on a 373 KB packet, 67–69 s) and is being retried; opus has
not been reached since its free window.

Its five fix-first items were: the hosted demo (open, needs the publish go), a US card-funded sandbox
merchant (open, not a code question), the second reader live (**already measured** — x9 carries both
readers, so this item was written against a stale reading of the packet), a CSV round-trip in the suite,
and the recording. Items 1, 2 and 5 are the same three gates they have been since round 7.

**Item 4 was built, and building it surfaced a real hole.**

`tests/http.test.ts` boots the actual server on a local port against a scratch book and goes through the
routes: 401 with no credentials, 200 on `/health`, the seller's page carrying no fund form and printing
who holds the verb, the funder's page carrying the form, `POST …/fund` as `seller` answering 403,
`/notices/register.csv` answering 403 to `seller` and 200 to `desk` with the header, the reference and
the digest still matching the bytes. Nothing on that path touches the network — `EXTRACT_API_KEY` and
`EXTRACT_B_API_KEY` are blanked in the child's environment, so the test cannot become a CI dependency on
a free tier.

Writing it is what showed that the username was never the authority it was documented as. `basicAuthIdentity`
mapped *any* unrecognised name to `desk`, and one shared password admitted all four names — which means
the seller, holding the very password the README tells judges to use, could log out, type `desk`, and
declare a default on the book. Every sentence in this build about "only the desk can close a claim" was
true of the buttons and false of the door. Fixed rather than reworded:

- an unrecognised username is refused, not granted the desk;
- `DEMO_PASSWORD_DESK` / `_SELLER` / `_FUNDER` / `_DEBTOR` let any side hold its own secret, and a side
  that does stops accepting the shared one;
- a side with no secret of its own keeps `DEMO_PASSWORD`, so partial configuration is a rollout and not
  a lockout; and
- if nothing at all is configured the app stays open and the session is the desk — the localhost default,
  unchanged.

The README now states which shape is which instead of implying the shared password is access control:
one secret is a gate on the door, and the role stops being something you can type your way into only when
the side holds its own. That distinction is also what makes the lens honest — a seller may *read* the
desk's page from any seat, and cannot press anything the name does not hold.

nemotron's own §4 misread that last part (it wrote that a seller in `?view=desk` "sees the desk's
notebook"). It does not: the register needs the desk lens *and* the desk name, which the new HTTP test
asserts over sockets rather than in a render function. The objection was wrong and the fix it pointed at
was real, which is the useful shape for a review.

Suite: **144 tests**, all offline. Also applied from its §4, both precision rather than feature:
the sandbox guard now says what it checks (hostname and scheme, not the certificate chain, not a
man-in-the-middle) and names the one network call in the repo's history that created a `PENDING` $1.00
payout batch; and the card-funding 422 is labelled as measured on the accounts this build holds, with
the untested case left unclaimed.

## 30. Round 10, nemotron again: 96, and the list of what is left (2026-10-30)

| Judge | Family | Score | Breakdown (TI/D/PI/Inn/Pres) | Weakest axis |
|---|---|---|---|---|
| nemotron-3-ultra-550b | NVIDIA | **96** | 20/20/19/20/17 | Presentation — the hosted URL and the recording |

Up two points from round 9, with Technological Implementation, Design and Innovation closed at 20. The
brief for this round changed in two ways the submitter asked for: the reviewers now have to produce a
**complete list of everything still to be done** — ordered by value per hour, costed, each item saying
what "done" looks like — rather than only the defects they noticed; and they have to make **two passes**
over the packet, verifying each claim against the text before they answer and dropping what they cannot
verify. The literal phrase "exercise abstract thinking" is still in the brief. The packet is also 19 KB
larger: it now carries `tests/http.test.ts`, the test count is 144, and item (f) in the heads-up list is
the credential model.

Its eight-item list, and what each one is:

| # | Item | Disposition |
|---|---|---|
| 1 | Public HTTPS URL and webhook registration | Open — needs the publish go; the repo is ready for it (`Dockerfile`, `.env.example`, `scripts/d0-webhook.ts`) |
| 2 | The under-3-minute recording | Open — `VIDEO.md` is the shot list; recording is outside the repository |
| 3 | US business sandbox merchant, card-funded split verified | Open — an account this build does not hold |
| 4 | A photographed POD where the two readers actually split | Open, and narrower than it sounds: x9 proves two readers read one photograph, but they agreed, so the ratchet is proven by test only. A split artefact would make it visible; it would not change a score already at 20 |
| 5 | A refund on a `COMPLETED` capture, freeze → default → repurchase recorded | Open — blocked on 3: this account's captures are all `PENDING` |
| 6 | A third jurisdiction profile (DE or AU) | Declined — the portability claim is already proven by two profiles plus `notModelled` lists; a third adds surface, not evidence the judges asked for |
| 7 | Prove the CSV opens safely in Excel, LibreOffice and Sheets | Declined as written — the escaping is asserted in the suite; installing three Spreadsheet applications to re-prove a cell prefix is spend without a claim behind it. The file is UTF-8 CSV with CRLF and no BOM, which is what the applications read |
| 8 | `docs/PRODUCTION.md` with Commerce Platform onboarding steps | Declined — the steps beyond "partner onboarding, platform payee onboarding, settlement reporting" are not measured here, and a document of plausible steps would be the one unverified page in the packet |

Items 1, 2, 3 and 5 are the same gates rounds 7, 8 and 9 named. They are account and screen work, not
build work, and the repository is primed for each: the demo boots with `npm ci && npm run seed && npm
start`, the Docker image takes `DEMO_PASSWORD`, and the webhook script registers against a host.

Its §5 checked every claim it scored and marked them true, including the two this round added — the
per-side secrets and the four-usernames-only door.

Round 10 continues: opus has not been reached since its free window, and gemini is being tried on a
trimmed packet because 503 is what it returns at this size.

## 31. Round 10 closed: 91–96 on the same desk, and what the spread says (2026-10-30)

| Run | Model | Packet | Score | Breakdown (TI/D/PI/Inn/Pres) |
|---|---|---|---|---|
| 10a | nemotron-3-ultra-550b | full | **96** | 20/20/19/20/17 |
| 10b | gemini-3.8-flash-free | trimmed (275 KB) | 92 | 19/19/17/19/18 |
| 10c | gemini-3.8-flash-free | trimmed, after the fixes below | 91 | 19/18/18/19/17 |
| 10d | nemotron-3-ultra-550b | full, after the fixes below | 92 | 20/19/19/20/14 |
| 10e | claude-opus-5 | full, 115 k prompt tokens | **91** | 19/17/16/18/**22** — printed, see below |

The same model on the same desk moved four points between two runs an hour apart (nemotron 96 → 92),
and gemini moved a point after a change that raised the axis it was complaining about (Potential
Impact 17 → 18) while it lowered Design and Presentation for reasons it had not raised before. The
lesson is not that the desk got worse; it is that a single number from a single run is not a
measurement. What is stable across all four runs is the list: deploy the demo, record the video,
provision a US merchant, and — for two of the four — produce a photograph the readers actually split
on. Nothing else appeared twice.

**What changed between the runs, and why.**

- *Market framing.* gemini's strongest objection was that a corporate freight debtor would never pay
  through PayPal. The paragraph that invited it named "a carrier's invoice" as the served market while
  the demo pair is a components supplier selling goods to a retail chain — and E00 treats a carriage
  sale as a service it cannot vouch for. Rewritten in DEVPOST to name the goods supplier and the small
  debtor, and to say explicitly why the demo pair is not a trucking company. gemini's Potential Impact
  went 17 → 18 on the next run.
- *The refusal arithmetic.* README said "625 of the 1,005 refused by the gate". 625 is the total; 620
  are gate refusals and 5 are pricing refusals, and the per-reason counts in the brief (210/96) were
  the synthetic plan before the two pinned demo refusals. Re-seeded into a scratch book and counted
  from `decisions`: 211 `POD_MISSING`, 148 `ADDRESS_MISMATCH`, 97 `CONSIGNEE_MISMATCH`, 74
  `TRACKING_INVALID`, 26, 26, 38 — 620 — plus 5 `BAND_LIMIT`. README and the brief now say that.
- *A live split that did not happen.* Two deliberately degraded copies of the same scan were read by
  both models. On the first they agreed on every field; on the second they also agreed, both dropping
  the three tracking digits under the smudge and both keeping the remaining nine at 0.75, which E02
  then refuses on length. The artefact is published as `x11-degraded-scan.jpg` and
  `x11-degraded-read.json`, and both documents now say the split remains a test-level claim. Forcing
  a split by doctoring a document would have been the one dishonest artefact in the packet.
- *A misleading note, found by that run.* When the label parser missed a field the two readers found,
  the note read "only one reader found a value (gemini + nemotron)" — true about the two sides being
  compared, wrong about what a reader would take from it. It now reads "found by … only (no value from
  …)", and the two tests that asserted the old wording were updated. Suite still 144, 0 fail.
- *Rendered pages.* nemotron's new Presentation deduction was that the deal-room evidence is HTML, not
  something a judge can open without running anything. The three lens pages and the two-reader deal
  room are now rendered at 1440 px and checked in as PNG beside their HTML, and DEVPOST and README
  point at them.
- *The deploy path, proven on the current code.* The image was rebuilt (`discount-window:round10`) and
  run twice: with `DEMO_PASSWORD` only, all four names open and an unknown name is refused; with
  `DEMO_PASSWORD` plus `DEMO_PASSWORD_DESK`, the desk refuses the shared secret and opens only with
  its own. `/health` 200, `/` 401 anonymous, both shapes as documented. Containers removed afterwards.

**What was declined, and why.** A third jurisdiction profile (Gemini's idea, 2 h): the portability
claim rests on two profiles plus explicit `notModelled` lists, and a third is more YAML for a criterion
already at 19–20. Opening the CSV in Excel/LibreOffice/Sheets (1 h): the escaping is asserted; the
applications are not the claim. `docs/PRODUCTION.md` (1 h): the steps beyond partner onboarding are not
measured here, and an unverified page is worse than an absent one. A CI workflow: the repository has no
remote yet, and a workflow that has never run is a screenshot of intent. Tracking-number check digits:
the risk is refusing real parcels whose carrier numbering this build cannot verify, which is worse than
the format check it would replace.

**One reviewer claim checked and rejected.** nemotron asked to harden the sandbox guard against
`svcs.sandbox.paypal.com`. `assertSandbox` admits exactly one host — `api-m.sandbox.paypal.com` — so
the Payouts host is already refused; the premise that it is accepted is wrong.

### 31.1 Opus, the fifth run: 91 printed, 92 in its own arithmetic (2026-10-30, 19:32 UTC)

The queued dispatch fired on time and answered in one pass: HTTP 200, 60 s, 114,929 prompt tokens in,
3,428 out, `finish=stop`. Review saved as `temp/reviews/opus-2026-10-30T193202982Z.md`. It scored
Technological Implementation 19, Design 17, Potential Impact 16, Innovation 18 and Presentation **22**
— an axis out of 20 that does not exist, and five axes that sum to 92 under a verdict line reading 91.
Neither slip changes its argument, but both are the reason its number is treated as a band, not a
measurement. It is the only run of the five that called Potential Impact the weakest axis.

**Where it is right, and what changed as a result.**

- *One currency.* "The single-currency USD decision is stated but not defended." It was not stated
  anywhere: `grep -i "usd\|currency\|fx"` found only the column default, the intake label and the
  PayPal amount, and no prose in README or DEVPOST. Both now carry one paragraph — intake takes an
  amount, every ledger row is written `USD`, a second currency is a rate, a settlement rule and a
  reporting rule this build does not model, and the column is therefore not a switch. This is the
  cheapest point on its list and the only one that was a defect rather than a boundary.
- *The video and the hosted URL.* Its Presentation deduction is directionally correct — no video
  exists — but the stated reason is not the rule: the video is a public YouTube link on the
  submission form, not repository content, and the hosted URL is optional when the repo carries run
  instructions. The build already satisfies the rule's second path; the video does not exist yet,
  and that is what costs the points.

**Where it is wrong, checked against the tree.**

- *"The missing FX/multi-payee production path."* Multi-payee is built and measured: one order, two
  purchase units, two payees, one capture, recorded in `evidence/published/x5-live-funding.json` and
  reproduced in `x2-three-payee-capture.json`; the funding page prints per-payee amounts and capture
  ids. The FX half of that sentence was true and is now closed; the multi-payee half is not. Part of
  Design's 17 therefore rests on an absent fact.
- *"The sponsor gap is acknowledged but not called out on the Devpost page itself."* `DEVPOST.md`
  ends its "Tools used" table with "Nothing from the sponsor list (AG Grid, APIMatic, Astropods,
  Bryntum, Channel3, Elastic, KERNEL, Postman, Zapier, Render) is used." The point was already met;
  the reviewer wrote as much one line later.

**Accepted and not done, with reasons.** A US business merchant and a refund on a `COMPLETED`
capture: both blocked on an account this build does not hold, and both already the top of §30's
table. A GitHub Actions workflow: previously declined for the reason that still holds — the
repository has no remote, and a workflow that has never run is a screenshot of intent. A carrier
API stub for E02: refused deliberately, because a stub would make the gate claim a check it did not
perform, which is the one thing this build does not do. A PNG of the three-way payer ledger next to
`x2-three-payee.json`: cheap and legitimate, deferred to the video pass because the same screen is
the maturity beat in `VIDEO.md`.

## 32. Round 11 — the improvement wave (2026-10-31)

Four commits of build, then the round-11 panels. What changed between round 10 and this round:

- **The machine surface** (`daf60e1`): `/status` (public, aggregate, chain re-walked on open),
  `/api/invoices`, `/api/invoices/{id}`, `/api/ledger` (desk-only, JSON 403s) — an agent can now
  read the book instead of screen-scraping it. PayPal webhook POSTs no longer require the shared
  password; their authority is the signature check, proven over HTTP by a forged-event test (stored,
  never acted on) and a replay test (answered `duplicate`, no second row).
- **Fix-my-refusal** (`ef6cf77`): every check in `rules/checks.yaml` carries a `seller_action`; the
  refusal card lists every reason with its fix sentence; a corrected document returns as a NEW
  receivable naming the refusal (refusals stay terminal; revisions from the whole correction chain;
  E06 still guards reuse). Measured fixture lesson: a resubmission scored against an empty declared
  record lands in band D — the desk refuses paper from a debtor with no record, which is correct.
- **The debtor record from the rail** (`0158406`): `RAIL_HISTORY=1` reconciles settled invoices
  against `GET /v1/reporting/transactions`. Measured against the sandbox: `Z` dates are refused as
  "Invalid date passed", a `+` offset dies as a space in the query string, the wire format is
  `-0000`, and the 31-day window cap is sliced. `x12-rail-history.json` is the honest artefact: one
  rail row in the window, zero matched, source declared — recorded, not glossed.
- **The audience**: the problem is now a maker in Aba selling to Texas on net-60 (Paga receiving,
  January 2026), widening in one sentence to the jurisdiction-as-YAML mechanism (`1dfc210`). The
  opener no longer claims the $4,200 invoice was funded.
- **Machine-surface documentation** (`cbeb9d9`): `docs/openapi.yaml` and a Postman collection,
  written against the routes as they answer.
- Round-11 iteration 1 closures (`4a41913`, `0c8f89c`): the CSV register neutralises a leading
  newline (nemotron's one real code finding — a quoted cell could still start a formula after a
  line break); doc counts updated from a stale 144 to the true 153; the submit page now says the
  readers take up to a minute and that the page does not spin while they work (gemini's Design
  finding, answered without breaking the zero-JS stance).

### 32.1 Iteration 1 — nemotron 96, gemini 94 (2026-10-31, ~13:50 UTC)

| Reviewer | Total | TI | Design | Impact | Innovation | Presentation |
|---|---|---|---|---|---|---|
| nemotron | **96** | 20 | 20 | 19 | 20 | 17 |
| gemini | **94** | 19 | 18 | 18 | 20 | 19 |

Nemotron withheld its three Presentation points for the video and hosted URL only, called
Innovation at 20 with the two-reader ratchet, E06's double key and the register's formula
neutralisation named, and its one code finding — the CSV newline — is closed above. Gemini's
weakest axis moved from Impact to Design (extraction has no progress feedback — answered by the
copy line, not by adding client JS); its Impact note repeats the Commerce Platform onboarding
bound. Both runs restated items that remain human-blocked (video, hosted URL, US card-funded
merchant) or previously declined with reasons (Commerce Platform onboarding document — a page of
plausible steps would be the one unverified page in the packet; the reason from round 10 stands).

### 32.2 Iterations 2 and 3 — the wave is stable at 93–96 (2026-10-31, ~14:00–14:45 UTC)

| Iteration | nemotron | gemini | Notes |
|---|---|---|---|
| 1 (full / short) | **96** | **94** | findings closed in §32.1 |
| 2 (full / short) | **96** | **94** | gemini moved Design 18→19, citing the refusal remediation and the wait-note |
| 3 (short / short) | **94** | **93** | cross-paired packets; the nemotron 96→94 swing is the same-model variance the round-10 rule already states |

Mean across six runs: nemotron 95.3, gemini 93.7. Both reviewers put Stage One as an explicit pass.
Withheld points, every time: the video and the hosted URL (human deliverables), the US card-funded
merchant (account-blocked, recorded since round 8), and the Commerce Platform onboarding bound
(stated, not hidden). New observations this round and their dispositions:

- *Unharmonized test count (144 vs 153) across files* (gemini, it.2): the current claims in
  README and DEVPOST both say 153. The 144s gemini saw are PLAN.md's historical journal entries —
  rounds 8–10 record what the suite was at the time, and a journal that erases its own past to
  please a reviewer is not a journal. Rebutted with this note.
- *Free-tier 429 cadence surfaced as a user-visible note rather than a queued retry* (nemotron,
  it.3): true and deliberate — a retry queue behind a free-tier reader would turn one slow verdict
  into an unbounded wait with no authority to spend. The note says what happened. Rebutted.
- *Commerce Platform onboarding document* (both, repeated): declined again, reason unchanged from
  round 10 — a page of plausible steps would be the one unverified page in the packet.
- *Three-reader evidence card* (nemotron, it.3): the phrase means the parser beside the two
  readers — the packet calls this out; no change.
