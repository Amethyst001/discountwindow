# The Discount Window

**Receivables, gated on proof.**

A $48,000 parts invoice is refused in seconds because the signature block names a different
company than the debtor. A $4,200 invoice from the same seller passes eleven checks, is priced from
the debtor's own payment history, and is funded by a single PayPal order that pays the seller's
advance and the platform fee in one capture. Both outcomes are on the same page, with the document,
the hash and the reason.

**Sandbox only.** Every payment in this build ran against `api-m.sandbox.paypal.com`; no real money
moves. The client refuses to start against any other host — a literal hostname-and-scheme check, not a
pattern match, so a typo in an env file cannot point the app at production. What that guard fixes is
*which host the client will speak to*; certificate validation is Node's, not this check's, and it is not
a defence against a machine in the middle. One network call in the repo's history did not move money at
all and is worth naming rather than glossing: a Payouts probe that returned HTTP 201 with a `PENDING`
$1.00 batch (`MMXFLV6EUC89Y`). It is kept as evidence, the API is called nowhere in the product, and the
code path was deleted — see *Why PayPal*.

---

## The problem

A freight-invoice financier loses money on three things: goods that were never delivered, delivery
to someone who is not the debtor, and the same paperwork funded twice. All three are visible in the
document set before a dollar is advanced — if someone opens the documents and compares them against
the debtor record. At volume nobody does.

So the desk does it, and makes the refusal the product. On the seeded book, **625 of 1,005 invoices
are refused** — 620 of them by the evidence gate, each with a machine-readable reason the seller can
act on: `POD_MISSING` (211), `ADDRESS_MISMATCH` (148), `CONSIGNEE_MISMATCH` (97), `TRACKING_INVALID` (74),
`NOT_DELIVERED` (26), `DELIVERY_DATE_OUT_OF_WINDOW` (26) and `NO_SIGNATURE_EVIDENCE` (38). The other five
pass every check and are then
refused by the pricing band, which caps the tenor it will buy — a second gate, with its own reason. The
counts are read from the data by the app; they are not copy.

## What it does

1. **Intake.** The seller uploads the invoice and the proof of delivery.
2. **Read twice.** A language model and a deterministic label parser both read the document. Their
   answers are reconciled field by field; a disagreement halves the confidence, and a field under the
   0.70 floor can fail a check but cannot pass one — the guard sits in the gate, not on the page. The
   deal room marks both values on the document and prints the two readings side by side, so the
   disputed line is visible, not narrated.
3. **Gate.** Eleven deterministic checks (E00–E10) run against the document, the debtor record, the
   document's hash and the tracking number it carries, under the jurisdiction profile the debtor's
   billing country selects. Nothing is priced until they pass.
4. **Score and price.** A six-part scorecard on the debtor — on-time rate, days late, exposure,
   relationship, disputes, size — sets the band; the band sets the rate, the LTV and the tenor cap.
5. **Fund.** The funder approves one PayPal order whose two purchase units divide the advance — the
   seller's net and the platform's origination fee. One capture pays both, to two different accounts.
   When that capture is recorded and the paper is owned outright, the desk issues the **notice of
   assignment**: a debtor who was never told can discharge the debt by paying its old seller, so this
   is the step that makes the purchase effective. The notice prints the rail's own status for the
   captures that paid for it — in this sandbox every one of them is `PENDING`, bank-funded, and the
   document says the assignment does not take effect if the capture does not clear, rather than
   pretending the money arrived. The bytes are stored, hashed into the audit chain,
   and served unmodified for anyone to re-hash. The desk can then record the attempt to serve it —
   channel, date, any reference it was given, and the digest recomputed from the stored bytes — in an
   append-only register that proves which text went out and says plainly that no carrier confirmed
   its arrival. The desk can hand that register over as one CSV — every invoice in the book, ordered by
   the date the entry says it went out, each row carrying its stored digest beside a recomputation from
   the bytes on disk, so an entry written before the notice was edited reports
   `NO - EDITS AFTER THIS ENTRY` rather than certifying text it never saw.
6. **Settle.** At maturity the debtor pays the face value once, into one order of two purchase units:
   the funder's principal plus yield plus fee reserve, and the seller's remainder. PayPal withholds
   its receiving fee from each payee rather than taking a unit of its own, and because the sandbox
   capture does not return that amount, the desk books it from the schedule it priced against and
   labels it an estimate on the receipt.
7. **And when the debtor does not pay.** The paper was bought on a term chosen at intake — with
   recourse, or without it for 4.00% a year more. Past the due date and the debtor's own
   jurisdiction's grace, the desk can declare default: recourse paper becomes a claim against the
   seller and the ledger posts *nothing*, because a promise to repurchase is not money; non-recourse
   paper is written off the same day, because that loss is the desk's. A repurchase is applied in
   whatever parts it arrives in, and a claim that goes bad is written off for the remainder only.

## Why PayPal

PayPal is not the payment button at the end of this product; it is the part that cannot be removed.
Three things here are PayPal facts rather than app assertions:

- **Who gets paid, by whom.** The advance, the fee, the principal, the yield and the remainder are
  purchase units of orders PayPal settles directly to each party's account. On this rail there is no
  balance for the platform to mismanage, because there is no point at which the platform owns the
  money — and no point at which a failed platform can strand a funder's payout. The corollary is
  honest: this is a fact about multi-payee settlement, not about the design's virtue. It narrows the
  money-transmission question rather than settling it as a matter of law, and it does not extinguish
  the platform's liability for reversals on captures it originated. Directing money between third
  parties is also what makes this shape a **PayPal Commerce Platform** capability rather than a
  checkout: the sandbox accepts the split, a production application needs partner onboarding, and the
  README says so where the 422 was measured.
- **The signal that freezes a position.** `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED` and
  `CUSTOMER.DISPUTE.*` arrive signed and are verified against PayPal's transmission before they may
  change any state. A refund on a captured payment freezes the funder's position on the desk.
- **Where the trade itself ran through PayPal**, the capture carries a protection status and dispute
  categories, and the desk gates on them (E00) before it believes a single page of paperwork. Two
  qualifications, stated rather than buried: those programmes cover *eligible purchases*, which is why
  freight carriage is not obviously one of them, and a receivable that never ran through the rail has
  no status to read — so E00 has a third answer, `NOT_ON_RAIL`, which lets the documents carry the
  decision at a price, and records on the invoice that the rail did not vouch for anything.
  The consequence for this market is worth naming instead of smoothing over: a carriage sale that
  *did* settle on PayPal returns `NOT_ELIGIBLE`, because the programme does not cover services, and
  `NOT_ELIGIBLE` is an adverse answer here — the desk refuses it. So for freight, the only answer that
  lets paper through is the absence of a rail transaction at all. That is not a bug to be engineered
  away, it is the honest shape of the signal: E00 can vouch for a goods sale and cannot vouch for a
  service, so services are funded on documents and debtor history at a demoted band, and the page says
  which of the three answers produced the decision.

Remove PayPal and what is left is a spreadsheet that trusts a PDF the seller printed — which is
exactly the risk this product exists to price.

**Honest boundary.** The third point is the one this build cannot demonstrate, and it says so on
every page. The sandbox account returns `UNKNOWN` for protection status, so E00 is recorded as a
sandbox override — written into the hash-chained audit log, visible on the invoice, and impossible
to enable outside the sandbox. The invoices in the seeded book are synthetic receivables that never
ran through any rail, so their E00 rows are overrides too; nothing in this build claims an `ELIGIBLE`
status it did not receive. What *is* demonstrated, with capture ids, is the settlement shape the
whole design depends on: one order paying more than one party.

**And the obvious question: why would a debtor pay through PayPal at all?** A large enterprise settles
on ACH from an ERP in scheduled batches, and this desk does not pretend otherwise about that market.
The debtor this build serves is the small one: a regional retail chain, a contractor or a wholesaler
whose supplier invoices it for goods it took delivery of, where the payment is already a click in a
wallet and the dispute history is already on the rail. That history is the collateral. It is also why
the demo pair is a components supplier and the retail chain it ships to, rather than a trucking
company: a goods sale is the case PayPal's protection programme can vouch for, and a carriage bill is
a service it cannot — the demotion described above, not a hypothetical. The seller gets paid in two
days instead of forty-five; the debtor pays what it owes, once, in the instrument it already uses;
and the desk's fee is priced into the advance rather than held as a balance by the desk. On a rail
that pays a single merchant account the desk *would* have to redistribute, which is why the claim is
scoped to this one.

## The two money beats, measured

Funding, live: order `07H42099RL265081V` reached `COMPLETED` with two captures —
`7G077633WE973480T` for **$489.76** to the seller and `8XN5263642050782V` for **$3.25** to the
platform. Both settled `PENDING` because the test buyer funded by bank; the state is recorded.

The shape maturity needs, proven live: an experimental order with **three** purchase units at
20/30/50 — captures `3HL15889SJ722022X`, `43M97402UB703411Y`, `7D0883560J436545Y` — settled to three
different accounts from one payer click. The desk itself books maturity as two units, because PayPal
takes its fee from each payee rather than as a unit; the three-way order is the experiment that shows
the fee *could* ride along if a party were ever made a payee of its own. What the experiment
establishes is the invariant: no platform balance exists at any point on this rail, so the
money-transmission question is answered by the platform's behaviour rather than by an argument. That
invariant is a property of multi-payee settlement, not of the desk's good intentions — on a rail that
pays a single merchant account, the platform would have to redistribute and would be holding the
money it claims never to hold. It is also not the end of the liability story: under the PayPal
partner agreement the platform merchant stays answerable for reversals on captures it originated,
which is why `PAYMENT.CAPTURE.REVERSED` freezes the position instead of being logged and ignored.

One PayPal API is deliberately unused, and that is a decision with a number attached to it. Payouts
(`POST /v1/payments/payouts`) is the tempting shape: the desk holds a balance and pushes money to
whichever party it owes. A probe against the sandbox was accepted — HTTP 201, batch `MMXFLV6EUC89Y`,
`batch_status: PENDING` for a $1.00 item — so the API works and was rejected anyway. Calling it would
put the platform in possession of the advance before anyone paid it, which is the exact balance this
design is built to avoid and the exact fact that turns a receivables desk into a money transmitter.
Every cent here moves because a party approved an order that named its own payee.

Two findings from the experiments changed the code:

- A split capture response carries **no `payee`, no `amount` and no `payer` block**. Allocation must
  be read from the order's purchase units, never from the capture. Getting this wrong would have
  posted every funder's slice to the wrong account while every test still passed.
- `GET /v2/payments/captures/{id}` returns the **payer** in `payee`, even for split captures. It is
  used to reconcile amounts and nothing else.

## The AI, and what it is not allowed to do

Nothing in this desk can be checked until someone turns a delivery receipt into fields. That is the
AI's job, and it is load-bearing: no reader, no `consigneeName`, no E04, no funding. What the model
is *not* allowed to do is decide. So the design reads every document more than once — at least with a
language model and with a deterministic label parser that only fills a field when an explicit label sits
in front of the value, and a photographed document is opened by two models before either meets the
parser — and reconciles the answers field by field, one pair of readers at a time:

| Case | Reconciled confidence |
|---|---|
| both readers agree | the higher of the two |
| only one reader found the value | 0.75, value kept — whichever reader found it |
| the readers disagree | half the lower one — under the 0.70 floor, so no check may pass on that field |

Applied once, that is a second opinion; applied down a chain of readers, it is a ratchet. Each field
carries the worst verdict any comparison gave it, so a split between the two models is still split after
the parser has agreed with one of them.

The parser is not a fallback for shyness about the model. It is the control that makes the model's
answer falsifiable: a field the model invents has nothing to agree with, and a field it misreads
contradicts the label parser, which is the one outcome the gate refuses outright. The model is sent
the document — that is its whole job — and nothing else: not the verdict, not the score, not the price,
not the payment, and it is never told what the gate decided. The deal room prints one column per reader,
every field confidence and the rules, so the agent's work is checkable per invoice rather than trusted.

Measured on a real upload: `gemini-3.8-flash-free` read six fields at 100%, both readers agreed, and
the invoice passed all eleven checks and priced. A second upload inside the same minute returned
HTTP 429, because the free reader allows one request a minute; the row records that reason, the
deterministic parser answers, and the gate still verifies. A third upload inside the window made no
network call at all. The reader is an endpoint, not a dependency: `EXTRACT_BASE_URL`,
`EXTRACT_API_KEY` and `EXTRACT_MODEL` point at any OpenAI-compatible chat route (and `EXTRACT_B_*` at a
second one), so the same build runs against a funded tier or a local model with no code change.

**A document with no text layer.** Most proofs of delivery in this trade are photographs of paper,
and a photograph has nothing for a label parser to read. Before this pass existed the desk refused
them, which is honest but useless. The vision pass sits *in front of* the readers, not inside the
gate: a model call returns the field set **and** a verbatim transcription of the printed lines, and
the deterministic parser then reads that transcription. A photographed document is opened by **two
models in different weight families**, asked the same question of the same bytes, and their field
answers are reconciled with the same three-case rule before the parser is consulted — so no field of
a photograph survives on one model's word. The parser keeps its teeth: a tracking number the field
pass invents is absent from its own transcription and falls to 0.75, and a consignee it restates
contradicts the transcription and refuses. What it cannot do is see the paper a second time, which is
why the second model is there, and why the deal-room card says where the text came from. The floor
applies to each comparison in turn, so a field the two models split on stays split: the parser reads
one of their transcriptions and cannot arbitrate a disagreement about the photograph. With only one
reader configured the desk says so on the page and on the record, and the second reader's absence —
or its failure, with the reason — is written into the notes.

Measured: [`scripts/make-scan.ps1`](scripts/make-scan.ps1) renders a delivery receipt as a JPEG —
rotated, sensor-noised, stamped and signed, 195,293 bytes, no text layer anywhere in the file. The
photograph is committed at `evidence/published/x6-scanned-pod.jpg` and its SHA-256 is the hash the
desk stored under E06, so the page and the file are provably the same document. The
model transcribed all fourteen printed lines and read tracking `774120098780`, consignee, delivery
date, address and signature at 91–100%; eleven checks passed and it priced at a $948.36 advance on a
$1,250.00 face (`evidence/published/x6-vision-read.json`). The first attempt at that same document
came back `HTTP 503 system_cpu_overloaded`; the invoice kept that reason verbatim on its card and
stayed refused. The failure path and the success path are the same shape with a different string in
the reason field.

Measured, two readers on the same photograph
([`evidence/published/x9-two-reader-vision.json`](evidence/published/x9-two-reader-vision.json),
page at [`evidence/published/x9-two-reader-deal-room.html`](evidence/published/x9-two-reader-deal-room.html),
rendered at [`x9-two-reader-deal-room.png`](evidence/published/x9-two-reader-deal-room.png),
probe at [`scripts/d0-two-readers.ts`](scripts/d0-two-readers.ts)): the receipt above, uploaded through
the running app's own `/submit` form, read by `gemini-3.8-flash-free` on BeatAPI and
`nvidia/nemotron-3.5-super-vl-120b-a12b` on the NVIDIA endpoint. Both returned
`774120098780`, `Halcyon Retail Group`, `2026-10-27`, the Austin address, signature and delivered, each
at 100% self-reported, and the label parser over the first model's transcription agreed with all six —
so the invoice priced, and the deal room shows three reading columns beside the value it used. The two
calls took 39.7 s together (the free tier's one-a-minute cadence applies to the first reader only). On a
second photograph of the same receipt, printed with tracking `774120098772` and committed as
`evidence/published/x9-scanned-pod-1053.jpg`
(`evidence/published/x9-two-reader-vision-scanned-pod-1053.json`), the same three readers agreed on
every field, which is the outcome the design is for: the readers are expected to agree, and the day they
do not is the day the field drops under the floor and the desk refuses. A deliberately degraded copy of
the first receipt was read the same way
([`x11-degraded-read.json`](evidence/published/x11-degraded-read.json)): both readers dropped the three
tracking digits under the smudge and kept the remaining nine at 0.75, which E02 refuses on length. A
photograph that makes the two readers split has not been produced here, so the split itself is proven in
the tests rather than in this evidence — the honest version of a claim that is easy to overstate.

**The hostile case the desk cannot read away.** A seller and a debtor in on it together can mail an
empty tracked envelope to the debtor's real address: a real tracking number, a genuine delivered scan,
the right consignee at the right street, a signature. E02 through E05 and E10 all pass, because what
they test is whether the documents agree with each other and with the debtor's record — no check in
this build weighs a pallet, and a manifest gross weight is the carrier's data, not the document's.
The desk's answer to that fraud is not a twelfth check, it is the shape of the trade: the claim has to
be aimed at a named debtor that will refuse to pay, the refusal lands in the default machine, the
debtor's dispute history is what set the band, and the relief from recourse that a phantom shipment
would exploit costs 4.00% a year and is refused outright on band C paper. A funder buying thin,
unverified paper without recourse is the loss this product prices rather than the one it pretends to
have eliminated.

## The book

[`src/ledger.ts`](src/ledger.ts) posts double-entry rows. Properties enforced by the schema and the
tests, not by convention:

- the ledger is append-only (SQLite triggers reject `UPDATE`/`DELETE`);
- each transaction must balance, asserted per posting in SQL;
- the audit log is hash-chained; `/health` re-walks the chain and reports a break;
- nothing is booked before it arrives. When a seller owes a repurchase, the claim is a row in the
  book and **no ledger entry**: the loss is taken when the money fails to come, not when it is
  convenient to pretend it will.

## The loss side

Receivables products are judged on the day the debtor does not pay, so the desk has a state machine
for it and a term chosen before it happens:

| | with recourse | without recourse |
|---|---|---|
| who holds the debtor's credit risk | the seller | the desk |
| price | the band's rate | +4.00% a year |
| band C paper | bought | **refused at any rate** |
| on default | a claim; ledger posts nothing | written off the same day |
| when money arrives | applied against each funder's unpaid remainder | the same posting, described as recovery |

The term is stored on the price row and inside the price audit entry, so it cannot be re-picked after
the outcome is known, and the three verbs that end a position — `default`, `repurchase`, `write off` —
are desk-only: neither the side that owes nor the side that lost may close the entry. The grace period
that starts it is read from the debtor's jurisdiction profile, so the same invoice is overdue in the
United States and still funded in the United Kingdom on the same date.
[`evidence/published/x8-default-recourse-chain.json`](evidence/published/x8-default-recourse-chain.json)
carries every balance in that sentence, reproducible with `node scripts/export-default.ts`.

A reversal is the same ending by a different road. If PayPal takes back money it already settled —
a chargeback on the maturity payment, a refund of a capture this desk originated — the funder's
position reopens, and the term decided at intake says who stands behind it: the seller repurchases
what came back, or a non-recourse position is written off. `PAYMENT.CAPTURE.REVERSED` therefore
freezes the invoice first, so nobody can settle a second time on top of money that is leaving. What
it does not do is decide the outcome: the reversal's disposition arrives days later, through a
dispute thread this desk cannot poll from the sandbox, so the loss is declared by the operator using
the same three verbs. That is a stated limit, not an omission dressed up as a design choice — the
refund and reversal path cannot be exercised here at all, because every capture this sandbox has ever
produced is `PENDING` and the Refunds API reverses only `COMPLETED` ones.

Because a clawback and a non-payment end the same way, one posting serves both: `repurchase` records
what arrived and against whose remainder, and does not ask how it travelled — a PayPal payment, a
wire, the next invoice paid short. A reversal that claws back money the seller already spent is
closed by the seller putting it back, which is that same entry, against the same claim, priced by
the same term chosen at intake. The desk never nets a clawback against a balance it does not hold.

## Where this travels

The gate is data at two levels. [`rules/checks.yaml`](rules/checks.yaml) holds the eleven checks, their
refusal codes and their rule sentences; [`rules/jurisdictions.yaml`](rules/jurisdictions.yaml) holds the
numbers those sentences read, one profile per country, and the debtor's billing address chooses which
one runs. Two profiles ship:

| | United States | United Kingdom |
|---|---|---|
| carriers E02 will believe | UPS, FedEx, USPS, DHL | UPS, FedEx, Royal Mail, DPD, Evri |
| address must carry | a ZIP, agreeing to five digits | a complete postcode (`EC1R 1PG`) |
| a delivery may be this stale | 90 days before the invoice | 60 days |
| a tenor may run this long | 90 days | 120 days |
| what PayPal calls the cover | Seller Protection | Purchase Protection |
| how long before paper is past due | 5 days of grace | 7 days |

The seeded book contains both: `A-1042` (Austin, FedEx) verifies under the US profile, and `MT-2207` —
a Royal Mail receipt to a London debtor — verifies under the GB profile, with the deal room printing
which profile decided and every number it supplied. [`tests/jurisdiction.test.ts`](tests/jurisdiction.test.ts)
and [`evidence/published/x7-jurisdiction-profiles.json`](evidence/published/x7-jurisdiction-profiles.json)
then decide the *same* document under both and record the difference: read with American tables the
British receipt is refused `TRACKING_INVALID` and `ADDRESS_MISMATCH`, and pushed out to a 120-day tenor
`TERMS_INVALID` joins them — while name matching, arithmetic, evidence hashes, the delivery window and
the signature check are untouched. A third country is a block of YAML, not a change to the money code.

What each profile deliberately does *not* read is written next to it in the file — VAT registration and
the FCA perimeter for the UK, UCC-1 filings and state licensing for the US — so the gap is on the
record rather than implied by silence.

One thing has no honest equivalent in any country: E00. It asks whether PayPal's own record stands
behind the sale, which is a fact about a payment rail rather than about a document — and the gate now
gives three answers, not two. `ELIGIBLE` can only come from PayPal. An adverse or unknown answer
refuses, unless the sandbox records it as an override. And a seller may state that the receivable never
ran through PayPal at all: that is recorded as an *absence on the record*, the sale verifies on its
documents and the debtor's history alone, and the price is set one band lower for the signal the desk
did not receive. Trade credit is mostly off-rail, so the third answer is what makes this a product for
a real book rather than only for the slice of it that already pays by wallet.

What would not survive a move: the claim that the platform is not a custodian. That rests on
PayPal paying each party directly from one order. A rail that settles to a single merchant account
and expects the platform to redistribute would reintroduce the balance this design deliberately
never creates.

The book is also one currency, USD, by construction: intake takes an amount and every ledger row is
written `USD`. So the cross-border question is answered here as a document question — two jurisdiction
profiles over the same receipt — and not as a currency one. A second currency is an FX policy this
build does not model, and the column is not a switch.

## Built during the submission period

Everything here was written for this event: the gate, the scorecard, the pricing, the PayPal client,
the ledger, the pages, the dataset generator and the tests. 144 tests, all offline, via `npm test` —
and one of them boots the real server on a local port and goes through the routes rather than the
functions under them: 401 for a username that is not one of the four, 401 when a side holding its own
secret is offered the shared one, 403 when a seller POSTs a fund, and the whole-book register CSV
arriving for the desk with its header, its reference and its digest still matching the bytes.
The measured sandbox responses are committed in `evidence/published/`; the raw run logs are
gitignored.

**What this is not.** Not escrow. Not a lender — the funder's own PayPal account pays the seller
directly. Not a marketplace with a platform balance. Not a law firm: it produces and keeps the notice
of assignment, and it cannot prove that notice was lawfully served, which is why both jurisdiction
profiles list service under `notModelled`. Not a claim that this can be rebuilt on Stripe:
the evidence source is the reason the product exists.

## Tools used

| Tool | What it does here | How it is used |
|---|---|---|
| PayPal Orders v2 (sandbox) | Moves every cent | An invoice is funded by one order whose purchase units each name their own payee; the funder approves it in PayPal's consent flow and the capture is booked from the order read back afterwards. The three-way maturity split is the same shape with more units. Capture ids in `evidence/published/x5-live-funding.json` and `x2-*`. |
| PayPal webhooks + `verify-webhook-signature` | Turns a rail event into a desk event | Every delivery is verified against PayPal's transmission before it may change state; an unverified body is stored as evidence and ignored. Dispute, refund and capture events resolve to an invoice and freeze, release or settle it. |
| PayPal Disputes API (sandbox simulate) | Exercises the freeze path without a real buyer | `evidence/published/x4-*.json`. |
| Payouts API | Deliberately not used | A Payouts call would put the platform in possession of the advance; the probe that measured the endpoint is kept and the code path deleted. |
| `gemini-3.8-flash-free` (BeatAPI) | Reader A of a photographed document | Returns fields, per-field confidence and a transcription. Never sees the verdict, the score, the price or the payment. |
| `nvidia/nemotron-3.5-super-vl-120b-a12b` (NVIDIA) | Reader B, different weights | Reads the same pixels; disagreement between A and B is reconciled before either meets the parser. |
| Deterministic label parser (no model) | Third opinion on the transcription | Regex over the reader's own text; agrees, contradicts, or finds nothing. |
| Node 24 (`node:http`, `node:sqlite`), `yaml`, `pdfjs-dist` | The whole runtime | Native TypeScript, no framework, no build step, no client-side JavaScript. `pdfjs-dist` exists only to read a PDF's text layer when one is present. |

Nothing from the sponsor list (AG Grid, APIMatic, Astropods, Bryntum, Channel3, Elastic, KERNEL,
Postman, Zapier, Render) is used, and nothing is bolted on to chase a prize: the ledger is a table on a
page because that is what the book is, not because a grid sponsor pays for one.

## Try it

- **Repo:** see the submission's repository link. MIT licence in the About section.
- **Run it:** `npm ci && npm run seed && npm start` — never touches the network unless a sandbox key
  is present. This is the functional demo the rules ask for: the seeded book, the gate, the funding
  button and the register all work offline from one command.
- **Demo:** the instance asks for a username and a password. The four usernames are the identities in
  the trade — `desk`, `seller`, `funder`, `debtor`; any other name is refused. Each may read the desk
  from all three sides, because the view is a lens and a lens is for reading; the buttons follow the
  name, so a seller wearing the desk's view is told who holds that verb rather than handed a button
  that answers 403. A side can also be given its own password, which stops it accepting the shared one
  and takes the role out of the hands of whoever is typing. Judges get the shared password — reading
  every side is the point of a demo; pressing the loss side is not, and is not what is shown.
- **Video:** under three minutes, no music, no third-party marks, recorded on this build at 1440 px.
