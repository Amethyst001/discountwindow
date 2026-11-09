# The Discount Window

A receivables desk where **nothing is offered for funding until an agent has proved the goods were
delivered**. A seller uploads an invoice and its proof of delivery; eleven deterministic checks read
the document; a six-part debtor scorecard sets the price; a funder's money reaches the seller in one
PayPal capture, and the debtor's payment at maturity pays the funder and the seller in a second one.

Built for the PayPal AI Hackathon. Every payment on these pages ran against the PayPal **sandbox**:
real orders, real captures, and a real signed delivery from PayPal's own webhook simulator — no real
money. The one rail event the sandbox cannot produce, a buyer's dispute, is exercised by that signed
sample and by tests, and is labelled as such wherever it appears.


## In one minute

**Who it's for:** funders and marketplaces that pay out early against export invoices, and the small
exporters who wait 30 to 90 days to be paid by a foreign buyer.

**The problem:** a funder who pays early is betting on documents. The bet goes wrong in three ways:
goods never delivered, delivery signed for someone other than the buyer, or the same paperwork
funded twice. Checking every document by hand doesn't scale, so small exporters mostly go unfunded.

**What it does:** the seller uploads an invoice and its proof of delivery. AI readers extract the
fields (two independent vision models for photographed documents), and eleven deterministic checks
decide. Each invoice is either **refused with a reason the seller can fix**, or **priced** from the
desk's own record with the debtor. The AI reads; the rules decide.

**PayPal:** Orders v2 with multi-payee purchase units, so one funder approval pays the seller's advance
and the platform's fee as separate captures and the platform never holds the money. Webhooks are
signature-verified before they can freeze a position. Transaction Search reconciles the debtor's
history behind `RAIL_HISTORY=1`.

**Honest scope:** PayPal sandbox only, no real money. The book of 1,007 invoices (626 refused) is
synthetic. 175 tests. No pilots or users yet.

**Links:** Video {VIDEO_URL} · Live demo https://the-discount-window.onrender.com · Repo https://github.com/Amethyst001/discountwindow

## Judge in 3 clicks

**Live demo:** https://the-discount-window.onrender.com. Reading needs no password: the instance runs with `DEMO_PUBLIC_READ=1`, so a
visitor is a read-only guest and the action buttons are shown switched off. The free instance sleeps when idle, so the first
load can take about a minute.

1. **https://the-discount-window.onrender.com/n/A-1043:** a $48,000 invoice refused with `CONSIGNEE_MISMATCH`. The delivery was signed
   for Halcyon Logistics; the debtor is Halcyon Retail Group. *Proves:* the gate refuses before any money
   moves, with the rule, a fix the seller can act on, the document's hash and an audit row.
2. **https://the-discount-window.onrender.com/n/A-1054:** a phone photo of a proof of delivery, shown on the page. Two vision models
   read the smudged tracking number as nine digits; FedEx numbers this desk accepts have 12, 15 or 20, so
   a deterministic rule refuses it. *Proves:* the AI reads, the rules decide.
3. **https://the-discount-window.onrender.com/n/NW-2277?view=funder:** a $650 invoice priced at a $493.01 advance. Signed in as
   `funder`, "Fund the seller's advance" creates one PayPal order with two payees (seller's advance and
   platform fee). *Proves:* settlement where the platform never holds the seller's money.

Also worth a click: **https://the-discount-window.onrender.com/n/A-1043-R2** (the corrected document, priced at a $36,428.01 advance;
the original stays refused) and **https://the-discount-window.onrender.com/status** (audit chain re-checked, counts, webhook
verdicts). Pressing Fund needs a sign-in (password in the Devpost testing instructions); the hosted instance
carries sandbox keys, so a signed-in funder can run the PayPal sandbox checkout end to end. The recorded sandbox run of NW-2277
(order and both capture ids) is in `evidence/published/x5-live-funding.json`.

## PayPal APIs this code calls

All calls go to `api-m.sandbox.paypal.com`; the client refuses any other host.

| Endpoint | Called from | What for |
|---|---|---|
| `POST /v1/oauth2/token` | `src/paypal.ts` | Client-credentials access token |
| `POST /v2/checkout/orders` | `src/store.ts` (funding and maturity) | One order with a purchase unit per payee: the seller's advance and the platform's fee at funding; the funder and the seller at maturity |
| `GET /v2/checkout/orders/{id}` | `src/server.ts` | Confirms the payer approved the order before capture |
| `POST /v2/checkout/orders/{id}/capture` | `src/store.ts` | Captures the approved order: one capture per purchase unit |
| `POST /v1/notifications/verify-webhook-signature` | `src/server.ts` | Every webhook is verified before it may change state; a check that cannot be made answers 503 so PayPal retries |
| `GET /v2/payments/captures/{id}` | `src/server.ts` | Debtor payment history from the desk's own captures (only with `RAIL_HISTORY=1`) |
| `GET /v1/reporting/transactions` | `src/server.ts` | Transaction Search for older payments, settled (`S`) rows only (only with `RAIL_HISTORY=1`) |

Used only by the sandbox experiment scripts in `scripts/`, not by the app: webhook registration
(`/v1/notifications/webhooks`), the webhook simulator, the Disputes API, and one Payouts probe that the
product deliberately does not use.

## What the AI does, and what it does not

- **Reader A** (any OpenAI-compatible model in `EXTRACT_*`; the recorded runs used `gemini-3.8-flash-free`):
  for a PDF or text proof it extracts the fields with a confidence per field, as a second opinion beside
  a deterministic label parser. For a photograph it also transcribes the page.
- **Reader B** (`EXTRACT_B_*`; recorded runs used `nvidia/nemotron-3.5-super-vl-120b-a12b`): reads the same
  photograph independently, with different weights.
- **Reconciliation, not trust:** agreement keeps the higher confidence, a field only one reader found drops
  to 0.75, and a disagreement is halved, which puts it under the 0.7 floor, so a split becomes a refusal.
- **What decides:** the eleven checks in `rules/checks.yaml` and `rules/jurisdictions.yaml`. The models
  never see the score, the price, the verdict or the payment.
- **Without keys** the app runs on the deterministic parser alone. A-1054's two model reads are a recorded
  run (`evidence/published/x11-degraded-read.json`) seeded into the book.

## Limitations

- **Sandbox only:** no real money moves, and the client will not talk to a production host.
- **Synthetic book:** the 1,007 invoices and the worked examples are generated; none is a real trade.
- **No users yet:** no pilots, partners or customers. It has not been tested on a real exporter's
  paperwork, and not with a Paga-linked PayPal account.
- **Platform account:** PayPal's multi-payee orders need a US business account as the platform; a
  Nigerian business account was refused at checkout (`PAYEE_ACCOUNT_LOCKED_OR_CLOSED`, measured).
- **Checks read formats, not carriers:** a tracking number is checked against the carrier's published
  format; the carrier is not queried.
- **One currency (USD).** No FX policy is modelled.
- **Hosted demo:** the free Render instance sleeps when idle, and a restart rebuilds the same seeded book,
  so anything done on the live demo is temporary. The shared demo password is a gate, not access control.
- **Notice of assignment:** the desk produces and keeps the notice; it cannot prove the notice was lawfully
  served.

---

## The problem it solves

A component maker in Aba sells parts to a buyer in Texas on net-60 terms. The factory has to run
before the money arrives, and the financier who would advance against the invoice is betting on
documents — and losing on three of them: goods that were never delivered, delivery to someone who
is not the debtor, and the same paperwork funded twice. All three are visible in the document set
before a dollar is advanced — if someone actually opens the documents and compares them against the
debtor record. At volume nobody does.

The cross-border leg is the constraint this build can measure. The seller is Nigerian; PayPal's
multi-payee orders require the platform account to be a US business — a Nigerian business account is
refused at checkout with `PAYEE_ACCOUNT_LOCKED_OR_CLOSED`, and that measurement is below with the rest
of the sandbox limits. The demo keeps the seller where the story is and the desk where the rail can
settle it; whether a particular Nigerian wallet can receive this seller's leg is a question for that
seller's own PayPal onboarding, not something this repository asserts. The gate underneath is not
regional — the same eleven checks read a US freight proof of delivery and a GB wholesaler's paperwork,
because a jurisdiction is a block of YAML, not a change to the money code.

This desk does that comparison as a gate. Refusals are the product — and not a dead end: every
refusal carries the sentence that says what the seller can do about it, and a corrected document
comes back as a resubmission that names the refusal it answers. The scorecard behind the price reads
this desk's own record with the debtor, never a bureau — and with `RAIL_HISTORY=1` it is reconciled
against the desk's own PayPal records, strongest source first: maturity captures read back from
`GET /v2/payments/captures/{id}` and matched by `custom_id`, then Transaction Search for payments that
predate the book, where only `S` (settled) rows count because a `P` row has not landed. The source and
the match count are written to the audit chain either way.

The refusal counts below are the gate at work: 626 of the 1,007 invoices the seed
produces today are refused, each with a machine-readable reason (`POD_MISSING`,
`CONSIGNEE_MISMATCH`, `DELIVERY_DATE_OUT_OF_WINDOW`, `EVIDENCE_REUSED`, …) that the seller can act
on. The counts name what the seeded book actually tripped; `EVIDENCE_REUSED` — the same document
offered twice, caught by its hash — is a live check the seed never happens to fire. The archive
counts are read from the data by the app, never hard-coded in the page.

## The two money beats

1. **Funding.** The funder approves one PayPal order whose two purchase units divide the advance —
   the seller's net and the platform's origination fee. PayPal pays each payee directly; the platform
   is one of them, and no omnibus balance is ever created.
2. **Maturity.** The debtor pays the face value in one order, again split by ownership: the funder's
   gross slice (advance + yield + the fee reserve priced into it) and the seller's remainder. One
   capture call settles both units, returning a capture per payee. PayPal withholds its receiving fee
   from each payee instead of taking a unit of its own, so that fee is booked from the priced schedule
   and shown as an estimate — the sandbox capture response does not return it.

Every unit carries `custom_id` = the invoice id, which is how an inbound webhook names its invoice
without guessing.

## The gate

Eleven checks, defined in [`rules/checks.yaml`](rules/checks.yaml) (data, not code), each with a
refusal code and a rule citation:

| Check | Question | Refusal |
|---|---|---|
| E00 | Does PayPal stand behind this sale — or is its silence on the record? | `PROTECTION_INELIGIBLE` |
| E01 | Is there a proof of delivery, and can it be read? | `POD_MISSING` / `POD_UNREADABLE` |
| E02 | Does the tracking number match a carrier this desk believes? | `TRACKING_INVALID` |
| E03 | Was it delivered, and inside the country's window before the invoice? | `NOT_DELIVERED` / `DELIVERY_DATE_OUT_OF_WINDOW` |
| E04 | Was the consignee the debtor? | `CONSIGNEE_MISMATCH` |
| E05 | Was it delivered to the debtor's billing address? | `ADDRESS_MISMATCH` |
| E06 | Has this document — or the parcel it describes — been used on another invoice? | `EVIDENCE_REUSED` / `TRACKER_REUSED` |
| E07 | Has this invoice already been financed? | `INVOICE_ALREADY_FINANCED` |
| E08 | Do the line items add up, and does the PO match? | `AMOUNT_MISMATCH` |
| E09 | Are the terms coherent (issue ≤ due, tenor inside the country's cap)? | `TERMS_INVALID` |
| E10 | Did someone sign for it, or is there a delivery photo? | `NO_SIGNATURE_EVIDENCE` |

Any check that reads a document field can also refuse with `POD_UNREADABLE`, when that field was
extracted below the country's confidence floor: a value the desk is unsure of may lose a check but may
not win one. A weakly read *absence* keeps its own code — a missing signature line is evidence the
seller can still go and find, not a page nobody could read.

**The eleven checks are one file; the numbers are another.** A receivable is decided under the
jurisdiction profile named by its debtor's billing country ([`rules/jurisdictions.yaml`](rules/jurisdictions.yaml)):
which carriers the desk will believe, what a postal code looks like, how stale a delivery may be, how
long a tenor may run, and what PayPal calls the protection behind the sale. Two profiles ship — the
United States (UPS, FedEx, USPS, DHL; ZIP+4; 90/90; Seller Protection) and the United Kingdom (UPS,
FedEx, Royal Mail, DPD, Evri; a full postcode; 60/120; Purchase Protection). The seeded book contains both:
`A-1042` verifies under the US profile and `MT-2207`, a Royal Mail receipt to a London debtor, verifies
under the GB profile, and [`tests/jurisdiction.test.ts`](tests/jurisdiction.test.ts) decides the *same
document* under both and asserts the verdicts differ — read with American tables the British receipt is
refused `TRACKING_INVALID` and `ADDRESS_MISMATCH`, and pushed to a 120-day tenor `TERMS_INVALID` joins
them, while the name match, the arithmetic, the evidence hash and the signature check do not move
([`evidence/published/x7-jurisdiction-profiles.json`](evidence/published/x7-jurisdiction-profiles.json)
carries all three decisions). Money code, price and ledger are untouched by any of it. What each profile deliberately does *not*
model is listed in the file (VAT numbers, UCC-1 filings, FCA perimeter), so the diff is on the record
rather than implied. Both settle in US dollars in this build.

**What the gate does not claim.** E02 checks a tracking number's *format* against the carriers named
in the debtor's profile; no carrier API is queried, and a well-formed number that never existed on a
manifest passes E02 — it is E03, E04, E05 and E10 that have to agree with it. E06 checks two things,
because one delivery can only finance one receivable: the SHA-256 of the bytes and the tracking number
printed on them, compared after normalisation to letters and digits, so a reprint of the same label
under a new invoice number is refused `TRACKER_REUSED` rather than passed for having arrived as a new
file. E00 has three answers,
not two, because a B2B receivable on trade-credit terms usually has **no PayPal transaction behind it
at all** — the payment to the platform is the first one the rail ever sees. Where the sale did settle
on PayPal, the programme's status is read as an eligible-purchase fact about that transaction (these
programmes cover eligible purchases rather than services, and freight carriage is not one of them);
where it did not, the intake records `NOT_ON_RAIL`, the gate says so on the card, and the desk prices
the position one band lower instead of pretending to a signal it does not have. An *adverse* answer —
the rail was asked and declined — still refuses outright. The sandbox returns `UNKNOWN` for the demo
accounts, so every invoice in this build records E00 as an override rather than a pass. And a
photographed receipt is corroborated by a second model that never shares weights with the first, plus
a parser reading the first model's own transcription: that parser can catch the model mapping a label
to the wrong value, but it cannot see the paper a second time — the second model can.

**The attack the gate cannot see.** An empty tracked envelope mailed to the debtor's real address
satisfies E02 through E05 and E10 — a live tracking number, a genuine delivered scan, the right
consignee and street, a signature. No check in this build weighs a shipment, because a manifest gross
weight is the carrier's data and no carrier is queried. What the desk does instead is treat the
hollow shipment as a *credit* event rather than a document event: the debtor refuses to pay, the
paper goes past due and into default, the seller's history is what set the band, and the relief from
recourse that a phantom shipment feeds on costs 4.00% a year and is refused outright on band C paper.
Recovering from a fraudulent seller is a legal matter this build does not model — see the
`notModelled` list in the jurisdiction profiles.

**The model never decides.** A document is read by more than one reader. A file with a text layer is
read once by a language model and once by a deterministic label parser. A photograph of a delivery
receipt has no text layer, so **two** models in different weight families open the same bytes and their
answers are reconciled with each other first, before the label parser reads one of their transcriptions.
Every comparison uses the same three cases: agreement keeps the confidence, a value only one reader
found is discounted to 0.75 whichever reader found it, and a disagreement halves it — which puts it
under the 0.70 floor. The floor is applied to each comparison in turn and the worst verdict on a field
is the one that stands, so a field the two models split on cannot be carried back over the floor by the
parser, which only ever reads one of their transcriptions. The floor is not a caption on the page: a
field read below it can fail a check but can never satisfy one, because the guard sits in the one place
all eleven checks report through. An invoice is refused rather than priced on a value the desk has
itself recorded as unreliable. A weak reading of an *absence* keeps its own reason — "no signature line
found" is a missing piece of evidence, not an unreadable document. Where the readings disagree, the deal
room marks both values in the document itself and prints one column per reader beside the value used, so
the reviewer sees the line the machine could not agree on rather than a prose note about it. Every
check, price and posting is deterministic and reproducible from the stored evidence hash.

On both photographs this build has read live the readers agreed on every field — and they agreed on a
deliberately degraded copy of the first as well
([`evidence/published/x11-degraded-scan.jpg`](evidence/published/x11-degraded-scan.jpg), read at
[`evidence/published/x11-degraded-read.json`](evidence/published/x11-degraded-read.json)): both dropped
the three tracking digits the smudge covered and both kept the remaining nine at 0.75, which E02 then
refuses on length. So the split is a property the tests exercise (`tests/extract.test.ts`,
`tests/pages.test.ts`), not an outcome a photograph in this repository has produced. The design is
built for agreement; the ratchet is what happens when agreement runs out.

The model call is optional and off by default. Point `EXTRACT_BASE_URL`, `EXTRACT_API_KEY` and
`EXTRACT_MODEL` at any OpenAI-compatible chat endpoint to enable it, and `EXTRACT_B_BASE_URL`,
`EXTRACT_B_API_KEY` and `EXTRACT_B_MODEL` at a second one — vision-capable, different family — to give a
photographed document two independent reads of its pixels. The free reader tier this project demonstrates
on allows one request a minute, so the app remembers the window after a 429: the deterministic parser
answers, and the deal room records exactly why a reader did not run for that document. With one reader
configured the page says so; with none it says that too.

## The price

```
band (A–D, six-part debtor scorecard)  →  rate = 8.0% + band premium + recourse term, LTV cap, tenor cap
gross slice   = face × share
fee reserve   = 2.9% of gross + $0.30      (PayPal's published US receiving fee)
net slice     = gross − fee reserve
discount      = net × rate × tenor / 365
advance       = net − discount
platform fee  = 0.5% of face               (charged to the seller, paid by the funder's capture)
```

Worked example, the pinned invoice **NW-2277** ($650.00 face, band B, 60 days, 80% LTV):

| | |
|---|---|
| gross slice | $520.00 |
| fee reserve | $15.38 |
| net slice | $504.62 |
| discount | $11.61 |
| **advance** | **$493.01** |
| platform fee | $3.25 |

The sandbox captures do not return PayPal's receiving fee, so maturity books it from the same
published schedule and labels it an estimate on the receipt. That is stated on the receipt itself.

## The book

[`src/ledger.ts`](src/ledger.ts) posts double-entry rows. Funding debits the funder's outlay and
credits the seller's advance and the platform fee; maturity debits clearing (the outside world) and
credits the funder's returned outlay, its yield, the seller's proceeds and PayPal's fee as a
contra-revenue line. Properties enforced by the schema and the tests, not by convention:

- the ledger is **append-only** (SQLite triggers reject `UPDATE`/`DELETE`);
- each transaction must **balance**, asserted per posting in SQL;
- the audit log is **hash-chained** — `/health` re-walks the chain and reports a break.

## The machine surface

The pages are for a human; the same objects are served as JSON for an agent. It is read-only on
purpose — a payment still needs a party's approval in PayPal's consent flow, so no token can move
money.

| Path | Auth | Returns |
|---|---|---|
| `/api/status` | none | the aggregate vitals, exactly what `/status` renders: chain integrity, counts, ledger totals by account **kind**, webhooks split verified/unverified |
| `/api/invoices` | desk | every invoice with score, band, price and status; `?status=REFUSED` is the archive as data |
| `/api/invoices/{id}` | desk | one deal room: checks, fix sentences, score, price, slices, audit chain, extraction |
| `/api/ledger` | desk | postings by transaction, account totals, the last twenty webhook verdicts |
| `POST /webhooks/paypal` | PayPal's signature | the rail's door |

[`docs/openapi.yaml`](docs/openapi.yaml) is the hand-written contract (OpenAPI 3.1) and
[`docs/postman-collection.json`](docs/postman-collection.json) is the same surface as an importable
collection. Both are checked against `src/server.ts` rather than generated from it. The JSON surface is
desk-only because a deal room carries the desk's notebook — the service register and raw extractions —
and the lens that hides those on a page is a render decision, not a data one.

## The notice of assignment

A receivable the debtor was never told about is a receivable the debtor can discharge by paying its
old seller. So when the funding capture is recorded and the paper is owned outright, the desk generates the
notice ([`src/notice.ts`](src/notice.ts)), stores the exact bytes in `notices`, hashes them and writes
the hash into the audit chain. `GET /invoices/:id/notice` serves those bytes and nothing else — no
footer, no regenerated wording — so anyone can hash the downloaded file and compare it with the digest
on the invoice page.

The notice also carries the rail's answer for the captures that paid for it, because in this sandbox
every one of them is `PENDING` (bank-funded) and a document that read as though the money had cleared
would be the desk overstating its own title. The line is generated from `commitments.capture_status`,
which holds one status per capture id and is corrected by the webhook when the rail reports
`PAYMENT.CAPTURE.COMPLETED` for a capture this desk booked — a funding that is half cleared is not
cleared. The stored notice is never rewritten when that happens: it records what the rail said on the
day it went out, and the digest still proves those bytes.

Every field in it comes from stored rows: the invoice, the parties, the funder whose money moved, the
address on file. No model writes a document that tells a debtor where to send money.

The desk can then write down that it sent it. `POST /invoices/:id/notice/service` appends a row to
`notice_service` — the channel, any reference the operator typed, the date, who entered it, and the
**digest recomputed from the stored bytes**, never taken from the form — and the table is append-only
by trigger, like the ledger, so an entry cannot be amended afterwards. The register shows on the desk
view of the deal room and nowhere else. What it proves is which text went out and that those bytes have
not been edited since; that the notice *arrived* is the operator's assertion, and the page says so in
those words. No postal or courier API is called, and none is pretended.

`GET /notices/register.csv` hands the same table over as one file, every invoice in the book, ordered by
the date the entry says it went out — the answer to "show me every notice you say you served", which is a
question about the book rather than one receivable. Each row carries the notice's stored digest beside a
recomputation of it from the bytes on disk, so an entry written before the notice was edited reports
`NO - EDITS AFTER THIS ENTRY` instead of certifying text it never saw. It is desk-only, behind the same
role check as the write-off, because the file names the debtor, the operator and the bytes. A reference
typed by anyone at all is neutralised on the way out: a cell that begins with `=`, `+`, `-`, `@`, a tab or
a carriage return gets a leading apostrophe and every quote is doubled, so the register cannot hand an
auditor's spreadsheet a live formula written by someone outside the desk.

It also states what it is not: not a demand, not a filing, not legal advice. Whether a notice was
*lawfully served* — UCC 9-406 in the US, Law of Property Act 1925 s.136 in England — is a question a
web page cannot answer, and both profiles list it under `notModelled` rather than letting the silence
imply it was handled.

## When the debtor does not pay

Receivables financing is only half a product if the only scripted outcome is payment. The other half
is a state machine, and its first input is a term chosen before anyone knows the outcome:

```
recourse        (default)  the seller repurchases what the funder advanced
non-recourse    (+4.00%/yr) the desk keeps the debtor's credit risk, and is paid for keeping it
```

Band C paper is bought with recourse at any rate — thin records are not a risk the desk takes into its
own name for price. The term is stored on the price row and in the price audit entry, so by the day the
paper defaults, nobody can pick the favourable side of it after the fact.

Then, in order:

1. **Past due.** On boot the book sweeps funded paper whose due date has passed its own jurisdiction's
   grace — 5 days in the US profile, 7 in the GB profile, read from the same file as the tenor cap.
   Past due is not closed: the debtor can still pay, and a late payment makes the funder whole out of
   the receivable rather than out of the seller, so the settle button stays live.
2. **Default, declared by the desk.** Recourse paper becomes an open *claim* and the ledger posts
   **nothing** — a promise to repurchase is not an asset, and booking it as a recovery would let the
   desk report a loss it has not yet taken. Non-recourse paper is written off the same day: the
   funder's outlay is credited, the loss debits its yield.
3. **Repurchase, applied in parts.** The desk records what actually arrived. Two partial payments add
   up against what each funder is still owed rather than overlapping; anything beyond the claim is
   refused with a 409 rather than booked.
4. **Or the claim goes bad.** Writing it off posts the same loss, described differently, and only for
   the remainder the seller never paid.
5. **A reversal lands in the same machine.** When PayPal claws back money it had already settled, the
   event freezes the invoice so nothing settles twice on top of money that is leaving, and the loss is
   then closed by the declared path above — recourse paper becomes a claim the seller repays, via the
   same `repurchase` posting, which records the amount and never asks the channel. The desk does not
   net a clawback against a balance it does not hold, and it does not decide the disposition of a
   dispute it cannot observe: every capture this sandbox produces is `PENDING`, so no refund or
   reversal has ever been executed here.

`default`, `repurchase` and `write off` are desk-only verbs: a seller allowed to declare its own debt
repurchased, or a funder allowed to close its own loss, is a book that reports what its counterparties
want. The lifecycle is exercised in [`tests/default.test.ts`](tests/default.test.ts), and every balance
in this section is reproducible from
[`evidence/published/x8-default-recourse-chain.json`](evidence/published/x8-default-recourse-chain.json)
with `node scripts/export-default.ts` — including the two grace periods disagreeing about the same
invoice on the same date.

## Webhooks

`POST /webhooks/paypal` verifies every delivery with
`/v1/notifications/verify-webhook-signature` before it may change anything. The four answers are
deliberately different:

| What happened | Answer | What the book does |
|---|---|---|
| signature verifies, event is new | `200 ok` | resolves and processes it |
| signature verifies, event id already processed | `200 duplicate` | nothing; the second delivery has no second effect |
| signature verifies, processing throws | `503` | leaves the row unprocessed, so the retry runs it again |
| signature is a **definite** failure | `200 unverified, stored` | keeps the body as evidence, `verified=0`, acts on nothing |
| signature **could not be checked** (no id, network, PayPal 5xx) | `503` | stores nothing, so the retry is not mistaken for a duplicate |

Unverified rows are capped at 200, oldest first, so a flood of junk cannot grow the book without
limit. The settlement page and `/status` show verified and unverified deliveries side by side, so the
contrast is visible rather than asserted.

A verified event is resolved to an invoice by, in order: `resource.custom_id`, the order id in
`supplementary_data.related_ids`, any `/orders/{id}` or `/captures/{id}` link, or the capture ids in
`disputed_transactions`. No match means no action. `CUSTOMER.DISPUTE.CREATED`,
`PAYMENT.CAPTURE.REFUNDED` and `PAYMENT.CAPTURE.REVERSED` freeze the position; `CUSTOMER.DISPUTE.RESOLVED`
releases it back to the status it held. Capture routes refuse to run against a frozen invoice.

Measured sandbox limitation: `/v1/notifications/simulate-event` delivers a signed canned sample but
rejects any caller-supplied `resource` (`400 MALFORMED_REQUEST_JSON /resource`), so a simulated event
cannot be aimed at one invoice. Attribution is exercised against real captured payments and in
[`tests/webhook.test.ts`](tests/webhook.test.ts).

## Run it

Requires **Node 24** (TypeScript runs directly; `node:sqlite` is built in).

```bash
npm ci
cp .env.example .env      # fill the PayPal sandbox credentials
npm start                 # http://localhost:3000 — an empty database seeds itself
npm run seed -- --reset   # rebuild the book from scratch
npm test                  # 175 tests, all offline
```

The seed is deterministic: 1,000 synthetic invoices plus the pinned demo set, and **626 of the 1,007**
are refused — 621 by the evidence gate, by first reason (211 `POD_MISSING`, 148 `ADDRESS_MISMATCH`, 97
`CONSIGNEE_MISMATCH`, 75 `TRACKING_INVALID`, 38 `NO_SIGNATURE_EVIDENCE`, 26 `NOT_DELIVERED`, 26
`DELIVERY_DATE_OUT_OF_WINDOW`), and 5 by the pricing band, which caps the tenor it will buy. The refused
paper carries $1,713,786 of the book's $2,776,022 face. First start against an empty database runs the
seed automatically so a fresh clone or container shows a working desk; set `DW_NO_AUTOSEED=1` to start
empty on purpose.

The server **refuses to start against anything but `api-m.sandbox.paypal.com`** — a literal host
check in [`src/config.ts`](src/config.ts), not a pattern match, so an env typo cannot reach production.

Secrets live in `.env` only. It is gitignored, and nothing in the repository, the logs or the UI
prints a client id, secret, or access token.

A public demo URL can create sandbox orders and captures, so it carries HTTP Basic and four named
identities — the username is who you are in the trade, and a name that is not one of the four is
refused rather than given a role:

| Username | May | Sees |
|---|---|---|
| `desk` | everything, including the loss side: declare default, apply a repurchase, write the claim off, export the service register | all three lenses, and the desk's own notebook |
| `seller` | upload an invoice and its proof of delivery | all three lenses, without the desk's notebook |
| `funder` | commit to a slice, approve and capture the funding order | all three lenses, without the desk's notebook |
| `debtor` | approve and capture the maturity payment | all three lenses, without the desk's notebook |

The lens and the authority are different things on purpose. Any signed-in name may read the trade from
either side — a funder who cannot see what the seller was told cannot check the desk's story, and a
judge should not have to log out to find out — but the buttons follow the username. A page will not
offer a step this session cannot perform: it names who holds that verb instead, read from the same table
the routes check against. The routes still answer 403 to a session acting outside its role, and only
the desk can call a default, close a claim, or export the register. Three rendered pages of that split
are checked in under `evidence/published/x10-lens-*.png` — a seller in the desk lens, a funder in the
desk lens, a seller in the funder lens — with the same pages as `.html` beside them.

**What the password does and does not do.** With only `DEMO_PASSWORD` set, one secret admits everyone
and the username picks the role — so whoever holds it can also type `desk` and hold every button. That
is a gate on the door, not access control, and it is the right shape for a link handed to judges who are
watching a screen. Set `DEMO_PASSWORD_DESK` — or any side's own secret — and that side stops accepting
the shared password, so the role is no longer something you can type your way into; a side left empty
keeps using `DEMO_PASSWORD`. With every secret empty — the localhost default — there is no password and
everyone is the desk.
`/health` stays open either way so the container health check works.

### Sandbox accounts

The platform's PayPal account must be a **US business** account. Measured: a Nigerian business
account is rejected at checkout with `PAYEE_ACCOUNT_LOCKED_OR_CLOSED`; a card-funded capture against
an unverified sandbox payee fails with `PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING`; and a PayPal payer
cannot also be a payee of the same order ("You are logging into the account of the seller for this
purchase"), so the debtor approves a maturity payment as its own account.

Each of those was measured on the accounts this build actually holds. Whether a US business sandbox
account would accept card funding of a *split* order is untested here, so the claim stays where the
evidence is: this wallet, this configuration, this 422.

**What the split-payment shape asks of a real deployment.** An order whose purchase units each name a
different payee is not a checkout; it is a marketplace payout, and PayPal reserves that to accounts
onboarded through the Commerce Platform partner flow. That is the honest reading of the 422 above: the
sandbox wallet exists, and it is not a platform-enabled payee, so card funding of a split order is
turned away at authorization while PayPal-balance funding goes through. A production desk therefore
does two things this demo cannot: it onboards its sellers and funders as platform payees (or operates
under an existing partner with `payment_method` metadata naming them), and it carries the settlement
reporting that comes with that role. Until then, every number in this build was produced by a PayPal
order approved in the sandbox — but by a wallet, not by a card. That is stated rather than smoothed
over, because the difference is the whole regulatory question of who is holding the money.

**The Payouts API is unused on purpose.** `POST /v1/payments/payouts` was probed and works — HTTP 201,
batch `MMXFLV6EUC89Y`, `PENDING` for a $1.00 item — and the product calls it nowhere. Paying parties
out of a balance the desk holds is the shape that makes a desk a money transmitter; here no money is
ever in the desk's hands to pay out of, because each party approves an order that names it as payee.

### Webhooks

Register the public URL, then restart so the app reads the new id:

```bash
node scripts/d0-webhook.ts https://your-public-host register
```

`relink-funding.ts` restores the measured funding for NW-2277 after a reseed, using the order and
capture ids recorded in `evidence/published/x5-live-funding.json`. Nothing is invented: the script
refuses to run if the evidence and the price disagree.

## Deploy

**Render (the hosted demo):** `render.yaml` is a Render Blueprint. In the Render dashboard choose
New > Blueprint, connect this repository, and set `DEMO_PASSWORD` when asked (sandbox `PAYPAL_*`
values are optional). Render builds the Dockerfile on the free plan, health-checks `/health`, and the
container seeds the synthetic book on its first start. Free instances sleep when idle, so the first
request after a pause takes about a minute. The disk is not persistent on the free plan: a redeploy
or restart rebuilds the same seeded book, and any sandbox captures made on the live demo are lost.
Live demo: https://the-discount-window.onrender.com

**Any container host:**

```bash
docker build -t discount-window .
docker run --rm -p 3000:3000 --env-file .env -e DEMO_PASSWORD='what you hand the judges' -v dw-data:/app/data discount-window
docker exec -it <container> node --disable-warning=ExperimentalWarning scripts/relink-funding.ts
```

For a demo where each side should hold its own secret — the username is then the authority, not
something a visitor can type — give each side a password instead of the shared one:

```bash
docker run --rm -p 3000:3000 --env-file .env \
  -e DEMO_PASSWORD_DESK=… -e DEMO_PASSWORD_SELLER=… \
  -e DEMO_PASSWORD_FUNDER=… -e DEMO_PASSWORD_DEBTOR=… \
  -v dw-data:/app/data discount-window
```

Once the app answers on a public HTTPS host, register the webhook against it and have PayPal deliver
one real event:

```bash
node --disable-warning=ExperimentalWarning scripts/d0-webhook.ts https://your.host.example
```

The image seeds itself on first start, runs as a non-root user, keeps SQLite on a volume at `/app/data`, and health-checks
`/health` (which also re-walks the audit hash chain). Any host that can run a container and give the
app an HTTPS URL will do; a Cloudflare quick tunnel is enough for sandbox webhooks.

## Layout

```
src/        server, router, HTML, gate, price, score, ledger, audit, PayPal client, seed
rules/      checks.yaml — the eleven checks; jurisdictions.yaml — the per-country numbers they read
scripts/    sandbox experiments (orders, multi-payee, webhooks, dispute attempt, approvals) and fixtures
tests/      175 tests: money, gate, price, ledger balance, settlement split, webhook attribution and
            retry rules, rail reconciliation, capture-first history, reader reconciliation,
            jurisdiction portability, default & recourse lifecycle, assignment notice integrity,
            offline funding preflight, sandbox host guard
evidence/   curated raw sandbox responses (evidence/published/); every measurement in this file can be re-read
```

## What this is not

It does not take custody, hold funds, or promise protection. PayPal settles each purchase unit
directly to its payee; the desk prices, proves and books. The three views — desk, seller, funder — are
a lens every signed-in name may wear, and they change emphasis, never permissions: a button belongs to
the username, not the query string, so a page never offers a step the session's role cannot perform.

It is one currency, USD. Intake takes an amount, not a currency, and every ledger row is written `USD`;
a second currency is an FX policy this build does not model — a rate, a settlement rule and a reporting
rule, none of them measured here — so the column is not a switch.

## Licence

MIT — see [LICENSE](LICENSE).
