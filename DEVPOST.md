# The Discount Window

**Receivables, gated on proof.**

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
synthetic. 167 tests. No pilots or users yet.

**Links:** Video {VIDEO_URL} · Live demo {RENDER_URL} · Repo https://github.com/Amethyst001/discountwindow

## Judge in 3 clicks

**Live demo:** {RENDER_URL}. Reading needs no password: the instance runs with `DEMO_PUBLIC_READ=1`, so a
visitor is a read-only guest and no button is offered. The free instance sleeps when idle, so the first
load can take about a minute.

1. **{RENDER_URL}/n/A-1043:** a $48,000 invoice refused with `CONSIGNEE_MISMATCH`. The delivery was signed
   for Halcyon Logistics; the debtor is Halcyon Retail Group. *Proves:* the gate refuses before any money
   moves, with the rule, a fix the seller can act on, the document's hash and an audit row.
2. **{RENDER_URL}/n/A-1054:** a phone photo of a proof of delivery, shown on the page. Two vision models
   read the smudged tracking number as nine digits; FedEx numbers this desk accepts have 12, 15 or 20, so
   a deterministic rule refuses it. *Proves:* the AI reads, the rules decide.
3. **{RENDER_URL}/n/NW-2277?view=funder:** a $650 invoice priced at a $493.01 advance. Signed in as
   `funder`, "Fund the seller's advance" creates one PayPal order with two payees (seller's advance and
   platform fee). *Proves:* settlement where the platform never holds the seller's money.

Also worth a click: **{RENDER_URL}/n/A-1043-R2** (the corrected document, priced at a $36,428.01 advance;
the original stays refused) and **{RENDER_URL}/status** (audit chain re-checked, counts, webhook
verdicts). Pressing Fund needs a sign-in (password in the Devpost testing instructions) and sandbox keys
on the instance; without keys it answers with a page that says so. The recorded sandbox run of NW-2277
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

A $48,000 parts invoice is refused in seconds: the proof of delivery is signed for **Halcyon
Logistics**, and the debtor is **Halcyon Retail Group**. The seller sends the corrected document back
as **A-1043-R2** — same face, same purchase order, a new revision number — and it passes the same
eleven checks and prices at a **$36,428.01** advance. A third invoice, **A-1054**, arrives as a
photograph; both vision readers return the same nine-digit tracking number, reconciled at 0.75
confidence, and the deterministic check refuses it outright because a FedEx number is twelve digits.
**A-1042**, the clean twin of the refused invoice, is priced on the same terms. Funding is exercised in
PayPal's **sandbox**: one order, one capture call, a capture per payee, with the capture ids in the
repo. The refusal and the price sit on the same page, with the document, its SHA-256 and the reason.

**Sandbox only, and synthetic paper.** Every payment in this build ran against
`api-m.sandbox.paypal.com`; no real money moves. The book of 1,007 receivables is seeded and says so
on its own front page — the four invoices above are the worked examples, not customers. The client
refuses to start against any other host — a literal hostname-and-scheme check, not a pattern match, so
a typo in an env file cannot point the app at production. What that guard fixes is *which host the
client will speak to*; certificate validation is Node's, not this check's, and it is not a defence
against a machine in the middle. One network call in the repo's history did not move money at all and
is worth naming rather than glossing: a Payouts probe that returned HTTP 201 with a `PENDING` $1.00
batch (`MMXFLV6EUC89Y`). It is kept as evidence, the API is called nowhere in the product, and the
code path was deleted — see *Why PayPal*.

---

## The problem

A component maker in Aba sells parts to a buyer in Texas on net-60 terms. The factory has to run
before the money arrives, and the financier who would advance against the invoice is betting on
documents — and losing on three of them: goods that were never delivered, delivery to someone who
is not the debtor, and the same paperwork funded twice. Catching that means opening the documents
and comparing them against the debtor's record. At volume, nobody does.

The scale is measured, not asserted: the Asian Development Bank's 2025 Global Trade Finance Gap
Survey estimates unmet demand for trade finance at **$2.5 trillion** — about 10% of global trade,
unchanged from 2023 — with small firms rejected for trade finance at **41%** of requests, and 84% of the surveyed banks already using AI for fraud
prevention and risk analysis. What the survey counts is unmet demand; what it does not capture is a
refusal the seller can read and act on — that is the gap this desk aims at. (Asian Development Bank,
*Demand for Trade Finance to Rise Amid Supply Chain Realignment—ADB Report*, news release,
15 January 2026.)

The cross-border leg is the constraint this build can measure. The seller is Nigerian; PayPal's
multi-payee orders require the **platform** account to be a US business — a Nigerian business account
is refused at checkout with `PAYEE_ACCOUNT_LOCKED_OR_CLOSED`, and that measurement is in the README
with the rest of the sandbox limits. So the demo keeps the seller where the story is and the desk
where the rail can settle it. Whether a particular Nigerian wallet can receive this seller's leg is a
question for that seller's own PayPal onboarding; this repository does not assert an answer to it.

The gate underneath is not regional. The same eleven checks read a US freight proof of delivery and
a GB wholesaler's paperwork, because a jurisdiction is a block of YAML (`rules/jurisdictions.yaml`),
not a change to the money code.

So the desk does the comparison, and makes the refusal the product. On the seeded book, **626 of 1,007
invoices are refused** — 621 of them by the evidence gate, each with a machine-readable reason the
seller can act on: `POD_MISSING` (211), `ADDRESS_MISMATCH` (148), `CONSIGNEE_MISMATCH` (97),
`TRACKING_INVALID` (75), `NO_SIGNATURE_EVIDENCE` (38), `NOT_DELIVERED` (26) and
`DELIVERY_DATE_OUT_OF_WINDOW` (26). The other five pass every check and are then refused by the pricing
band, which caps the tenor it will buy — a second gate, with its own reason. The refused paper carries
**$1,713,786 of the book's $2,776,022 face**. The counts are read from the data by the app; they are not
copy.

## What it does

1. **Intake.** The seller uploads the invoice and the proof of delivery. A refusal is not a dead end: the refused deal room carries the fix sentence for the check that failed, and a corrected document comes back as a resubmission that names the refusal — which stays refused in the audit chain, and whose evidence can never finance a second receivable.
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
   The record behind the scorecard comes from this desk's own history with the debtor, never from a
   bureau — and with `RAIL_HISTORY=1` it is reconciled against PayPal's own records, strongest source
   first. A maturity capture this desk created is read back from `GET /v2/payments/captures/{id}` and
   matched to its invoice by `custom_id`, so no amount-and-email guess is involved. Failing that,
   Transaction Search over the desk's account supplies payments that predate the book; only `S`
   (settled) rows count, because a `P` row has not landed and cannot make a debtor look on time. The
   source and the match count are written to the hash-chained audit chain either way; a rail that will
   not answer falls back to the declared record — recorded, not glossed.
5. **Fund.** The funder approves one PayPal order whose two purchase units divide the advance — the
   seller's net and the platform's origination fee. One capture call settles both units and PayPal
   returns a capture per payee, so two different accounts are paid by the one approval.
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
a service it cannot — the demotion described above, not a hypothetical. The seller is paid when the
funder's capture clears rather than on the sixty-day promise — in this sandbox the captures stay
`PENDING` because the test buyer funded by bank, and the pages say so. The debtor pays what it owes,
once, in the instrument it already uses; and the desk's fee is priced into the advance rather than held
as a balance by the desk. On a rail that pays a single merchant account the desk *would* have to
redistribute, which is why the claim is scoped to this one.

## The two money beats, measured in the sandbox

Funding, live in the sandbox (no real money): order `07H42099RL265081V` reached `COMPLETED` with two
captures — `7G077633WE973480T` for **$489.76** to the seller and `8XN5263642050782V` for **$3.25** to
the platform. Both settled `PENDING` because the test buyer funded by bank; the state is recorded, not
upgraded.

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
do not is the day the field drops under the floor and the desk refuses. A deliberately degraded copy of the first receipt was read the same way
([`x11-degraded-read.json`](evidence/published/x11-degraded-read.json)): both readers returned the same
nine tracking digits under the smudge — one at 0.50 self-reported confidence, one at 1.00 — and the
label parser found no tracking value at all, because the label itself was covered. Reconciled, the
field sits at 0.75: above the 0.70 floor, so it is a value the desk may use, and E02 still refuses it
because a FedEx number is twelve digits, not nine. That invoice is seeded as **A-1054**; its page
carries the photograph's SHA-256 (`6d16bba…`), both readers' answers, the parser's silence, and the
sentence "120098780 is not a well-formed FedEx tracking number". A photograph that makes the two
readers *split* has not been produced here, so the split itself is proven in the tests rather than in
this evidence — the honest version of a claim that is easy to overstate. The A-1054 beat is the
opposite and stronger lesson: the model was allowed to speak, and a deterministic rule overruled it.

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

## The machine surface

The desk is a product for humans, but the objects behind it are readable by a program without
scraping the HTML. The surface is small and read-only on purpose: an agent can read the book, one deal
room and the ledger; it cannot move a cent, because a payment still needs a party's own approval in
PayPal's consent flow.

| Path | Auth | What it returns |
|---|---|---|
| `GET /api/status` | none | The same aggregate data as `/status`: chain integrity, counts, ledger totals **by account kind** (never by account code, because codes carry party ids), and webhooks split into verified and unverified. |
| `GET /api/invoices` | desk | Every invoice with its score, band, price and status; `?status=REFUSED` is the refusal archive as data. |
| `GET /api/invoices/{id}` | desk | One deal room as an object: the eleven checks, the refusals with their fix sentences, the score, the price, the slices, the audit chain, the extraction. |
| `GET /api/ledger` | desk | Double-entry rows grouped by transaction, the account totals, and the last twenty webhook deliveries with their signature verdicts. |
| `POST /webhooks/paypal` | PayPal's signature | The rail's door; its authority is the signature check, never a password. |

The contract is committed, hand-written against `src/server.ts`, and kept deliberately honest: every
path in [`docs/openapi.yaml`](docs/openapi.yaml) answers on a running server, and every path not in it
is HTML for a human. [`docs/postman-collection.json`](docs/postman-collection.json) is the same surface
as a collection you can import and run; neither is generated from a schema the server does not
enforce. On the webhook door the distinction that matters is written into both: a **definite** bad
signature is stored as evidence and changes nothing, while a check that **could not be made** is
answered 503 and stored nowhere, so PayPal's retry is not mistaken for a duplicate. A verified event
whose processing throws is left unprocessed and answered 503 for the same reason. Unverified rows are
capped at 200, oldest first, so a flood of junk cannot grow the book without limit.

This is also the honest shape of the AI story: the model's output is an object on the deal room, with
per-field confidence and both readers' columns, not a private step a judge has to take on trust. An
agent reads exactly what a human reviewer reads.

## Built during the submission period

Everything here was written for this event: the gate, the scorecard, the pricing, the PayPal client,
the ledger, the pages, the dataset generator, the API contract and the tests. **167 tests, all passing and offline**
(no network or keys needed), via `npm test` — and one of them boots the real server on a local port and goes through the routes
rather than the functions under them: 401 for a username that is not one of the four, 401 when a side
holding its own secret is offered the shared one, 403 when a seller POSTs a fund, 503 when a fund press
has no sandbox keys (before any order exists), and the whole-book register CSV arriving for the desk
with its header, its reference and its digest still matching the bytes. The measured sandbox responses
are committed in `evidence/published/`; the raw run logs are gitignored.

**What this is not.** Not escrow. Not a lender — the funder's own PayPal account pays the seller
directly. Not a marketplace with a platform balance. Not a law firm: it produces and keeps the notice
of assignment, and it cannot prove that notice was lawfully served, which is why both jurisdiction
profiles list service under `notModelled`. Not a claim that this can be rebuilt on Stripe:
the evidence source is the reason the product exists.

## Tools used

| Tool | What it does here | How it is used |
|---|---|---|
| PayPal Orders v2 (sandbox) | Moves every cent | An invoice is funded by one order whose purchase units each name their own payee; the funder approves it in PayPal's consent flow and the capture is booked from the order read back afterwards. The three-way maturity split is the same shape with more units. Capture ids in `evidence/published/x5-live-funding.json` and `x2-*`. |
| PayPal webhooks + `verify-webhook-signature` | Turns a rail event into a desk event | Every delivery is verified against PayPal's transmission before it may change state. A definite failure is stored as evidence and ignored; a check that could not be made is answered 503 and stored nowhere so the retry still runs; a verified event is deduped on its event id and retried if its processing failed. Dispute, refund and capture events resolve to an invoice and freeze, release or settle it. |
| PayPal Disputes API (sandbox simulate) | Exercises the freeze path without a real buyer | `evidence/published/x4-*.json`. |
| Payouts API | Deliberately not used | A Payouts call would put the platform in possession of the advance; the probe that measured the endpoint is kept and the code path deleted. |
| `gemini-3.8-flash-free` (BeatAPI) | Reader A of a photographed document | Returns fields, per-field confidence and a transcription. Never sees the verdict, the score, the price or the payment. |
| `nvidia/nemotron-3.5-super-vl-120b-a12b` (NVIDIA) | Reader B, different weights | Reads the same pixels; disagreement between A and B is reconciled before either meets the parser. |
| Deterministic label parser (no model) | Third opinion on the transcription | Regex over the reader's own text; agrees, contradicts, or finds nothing. |
| Node 24 (`node:http`, `node:sqlite`), `yaml`, `pdfjs-dist` | The whole runtime | Native TypeScript, no framework, no build step, no client-side JavaScript. `pdfjs-dist` exists only to read a PDF's text layer when one is present. |

The demo is hosted on **Render** from `render.yaml` (Docker, free plan; the container seeds the
synthetic book on start, so every cold start shows the same desk). No sponsor SDK is used. The other
artifact with a sponsor's name on it is `docs/postman-collection.json`, and it is a hand-written JSON file in Postman's
public collection format, committed so the API can be exercised without a client; Postman itself is
not a dependency of the build and no Postman workspace is part of the demo. AG Grid is not used — the
book is three HTML tables. The same rule covers the rest of the sponsor list: nothing is bolted on to
chase a prize.

## Try it

- **Repo:** https://github.com/Amethyst001/discountwindow (MIT licence, shown in the About section).
- **Run it locally:** Node 24, then `npm ci && npm start` and open http://localhost:3000. An empty
  database seeds itself (`npm run seed -- --reset` rebuilds it). Locally there is no password: with no
  `DEMO_PASSWORD` set, every visitor is the desk. Nothing touches the network unless sandbox keys are
  in `.env`; without them the Fund button answers with a 503 page that explains what is missing.
- **Start here:** `/` carries a five-link strip in the order the product decides them — `A-1043`
  (refused), `A-1043-R2` (the corrected document, priced), `A-1054` (the photograph the model read
  short, refused), `A-1042` (the clean twin, priced) and `NW-2277` (the small invoice the funding
  button is for).
  `/status` proves the book with no login: chain integrity, counts, ledger and webhook verdicts.
  `/api/status` is the same data as JSON; `docs/openapi.yaml` is the contract.
- **Demo:** the instance asks for a username and a password. The four usernames are the identities in
  the trade — `desk`, `seller`, `funder`, `debtor`; any other name is refused. Each may read the desk
  from all three sides, because the view is a lens and a lens is for reading; the buttons follow the
  name, so a seller wearing the desk's view is told who holds that verb rather than handed a button
  that answers 403. A side can also be given its own password, which stops it accepting the shared one
  and takes the role out of the hands of whoever is typing.
- **Live demo:** {RENDER_URL} (Render free instance; the first load can take about a minute to wake).
  Sign in as `desk`, `seller`, `funder` or `debtor`. The password is given in the Devpost
  testing-instructions field; it is set as an environment variable on Render and is not in this repo.
- **Video (voiced, captions, under three minutes):** {VIDEO_URL}. The shot list and narration are in
  [`VIDEO.md`](VIDEO.md). Every page it shows exists in the seeded book.

## Submission assets

All brand pieces come from this build's own palette (`src/html.ts`: paper `#f4efe4`, ink `#191712`,
oxblood `#78211f`) — no third-party marks anywhere in the pack.

- **Thumbnail and video frame:** `brand/05_thumbnail.jpg` — 1280×720, the wordmark and tagline on the
  left, one invoice carrying a single REFUSED verdict with its reason on the right. Lead image for the
  gallery and the YouTube thumbnail.
- **Gallery:** `brand/03_palette_type.png` (colour and type sheet rendered from the app's CSS) and
  `brand/01_logo_primary.jpg`.
- **In-app:** the app serves its own favicon from `/favicon.ico` (`brand/`, recoloured to the app's
  ink), and the invoice card on the banner carries A-1043's real refusal — `CONSIGNEE MISMATCH`,
  $48,000, Northwind Components Ltd — the same numbers the Start-here strip opens on. One invoice,
  one verdict: the banner shows a single stamp because the product refuses or prices each invoice,
  never both.
