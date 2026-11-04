# Video script — under 3:00

**A finished cut exists:** [`video/the-discount-window-demo.mp4`](video/the-discount-window-demo.mp4) —
1:24, 1440×900, 25 fps, silent with burned-in captions, built from headless 1440px renders of the real
seeded pages (no re-enactment; every frame is the app). The NW-2277 funding beat uses the honest replay
caption pointing at `evidence/published/x5-live-funding.json`, exactly as the fallback below prescribes.
A voice-over re-record on the same beat table is still the stronger cut — the script and timings below
are the voice version.

One take, one screen, no music, no third-party marks, 1440 px wide at 100% zoom, cursor visible.
Every page shown exists in the seeded book. One beat can be live: the **NW-2277 funding in PayPal's
sandbox**. If the funder login is not ready, that same beat uses the committed capture ids in
`evidence/published/x5-live-funding.json`, on screen as **sandbox replay — recorded 31 Oct 2026**, and
the voice says "recorded earlier in this sandbox" — never "live".

**Before recording**

1. `npm start`. Open `/` and use the Start-here strip; do not type invoice ids, they contain the seed
   hash and change on reseed.
2. Tabs, left to right: `/` (Start here), **A-1043**, **A-1043-R2**, **A-1054**, **A-1042**,
   **NW-2277**, `/status`.
3. Check each tab before the take:
   - A-1043: **Refused**, `CONSIGNEE_MISMATCH`, "Consignee \"Halcyon Logistics\" does not match the
     debtor \"Halcyon Retail Group\"."
   - A-1043-R2: "Corrected submission of A-1043", **priced**, advance **$36,428.01**.
   - A-1054: the photograph's SHA-256 starting `6d16bba…`, both readers named, tracking field at
     **75%**, refusal "120098780 is not a well-formed FedEx tracking number".
   - A-1042: **priced**, score **78**, band **B**, rate **14.0%**, advance **$36,428.01**.
   - NW-2277: the funder sees a Fund button; the screen shows the $650 face and $493.01 advance.
4. Sign in as `funder` in a second window and log into the sandbox buyer account, so the approval is
   one click. Do not show the password field.
5. Dry run with a stopwatch. If the funding approval is not on screen by 1:24, switch to the replay
   card before recording — do not improvise it on the take.

| t | On screen | Voice |
|---|---|---|
| 0:00 | A-1043 refusal card: $48,000, `CONSIGNEE_MISMATCH` | "Forty-eight thousand dollars, refused before funding. The delivery was signed for Halcyon Logistics; the debtor is Halcyon Retail Group." |
| 0:10 | The document, the consignee boxed beside the debtor name | "One line is enough. The parcel is real; the paper names the wrong company." |
| 0:18 | Audit rows: extraction, gate, refusal, each hashed | "The refusal is hashed into the chain — and it is not a dead end." |
| 0:24 | A-1043-R2, "Corrected submission of A-1043" | "The seller uploads the corrected proof. Same forty-eight thousand, same purchase order — a revision, not an edit." |
| 0:34 | A-1043-R2 priced: advance $36,428.01 | "It passes the same eleven checks and prices at thirty-six thousand, four hundred and twenty-eight dollars. The refused original stays refused." |
| 0:44 | A-1054, the model card: two readers, tracking at 75% | "This one arrived as a photograph. Two vision models read the smudged tracking number as nine digits; the parser found nothing under the smudge. Reconciled confidence: seventy-five per cent." |
| 0:58 | A-1054 refusal sentence | "Above the floor, and still refused — a FedEx number is twelve digits, not nine. The AI is allowed to speak; it is not allowed to decide." |
| 1:08 | A-1042 priced: 78, band B, 14.0%, $36,428.01 | "The clean twin of the refused invoice: same seller, same face, same purchase order. The score is this desk's own record with the debtor, not a bureau." |
| 1:22 | NW-2277 Fund → PayPal approval → capture | "The funder approves one order. One capture call, a capture per payee: the seller's advance and the platform's fee. This is PayPal's sandbox; no real money moves." |
| 1:42 | NW-2277 after capture, the two units and their capture ids | "Two purchase units, two accounts, one payment. The platform never holds the balance." |
| 1:50 | `/status` | "The book proves itself with no login: one thousand and seven invoices, six hundred and twenty-six refused; the audit chain re-walked and intact. The ledger appears only when money moves. And the webhook count is split — signature-verified events that may act, stored-unverified bodies that may not." |
| 2:10 | Final card | "Refusals are the product. Not escrow, not a lender, not a marketplace. Sandbox only." |

**Do not say**

- "Escrow", "we hold the money", "guaranteed", "protected by PayPal" — the build takes no custody and
  the sandbox returns no protection status.
- "The AI disagreed" — on A-1054 both readers returned the same nine digits; the refusal is E02's
  deterministic length rule, not a split.
- "Customer", "pilot" or "live business" about any seeded invoice — the book is synthetic and says so.
- "Live" over the replay card, or over any capture already recorded.
- Any number that is not on screen at that moment. Read the counts from `/status`.

**Timing budget:** 2:18 scripted, 2:30 ceiling. If the dry run breaks it, cut in this order: the
after-capture units sentence (1:42), then the audit-row beat (0:18) — never the A-1054 refusal, the
A-1042 price or the funding itself.
