# Video script — under 3:00

One take, one screen, no music, no third-party marks. Exactly one live capture: the funding.
The maturity beat shows the order that is genuinely waiting, and the three-way split as recorded
sandbox evidence labelled **sandbox replay** — nothing is presented as paid that has not been
captured. If the timed dry run passes 2:10, cut the dispute beat — never the refusal or the model card.

**Before recording**

1. `npm start` on the seeded book, browser at 1440 wide, zoom 100%.
2. Open four tabs in order: A-1043 (refusal), A-1051 (model read), U-3827 (funding order awaiting
   approval), NW-2277 (due, awaiting debtor).
3. Confirm the funding order is still unapproved: U-3827 shows "Committed, awaiting approval".
4. Confirm the model window is open: open A-1051 and check the card names both readers —
   `gemini-3.8-flash-free` and `nvidia/nemotron-3.5-super-vl-120b-a12b` each read the photograph. If it
   says the second reader was skipped or unavailable, wait 60 s and re-upload to a scratch invoice
   before starting; do not record a one-reader card and talk about two.
5. Log the funder's sandbox account in the second window so the approval click is one click.
6. Dry run with a stopwatch. If the funding approval is not already on screen at 0:50, stop and fix.

| t | On screen | Voice |
|---|---|---|
| 0:00 | Refusal card, A-1043, $48,000, `CONSIGNEE_MISMATCH` | "Forty-eight thousand dollars, refused before funding. Here is the line that failed." |
| 0:08 | The document; consignee boxed beside the debtor name | "The signature block names a different company than the invoice." |
| 0:16 | Audit chain: extraction, gate, refusal, each hashed | "No proof, no funding — and the refusal is on the record." |
| 0:24 | A-1051, "How the document was read": one column per reader, the split field shaded | "Two models open a photograph, and a label parser only reads what one of them transcribed. Agreement keeps the confidence; disagreement halves it — and a field under the floor cannot pass a check, so the machine is never allowed to be sure about what it said it guessed." |
| 0:38 | Eleven checks pass; score 83 band B; 14.0%; $58.81 discount; advance $3,203.45 | "The debtor's own history prices it. The model never touches the number." |
| 0:50 | U-3827 awaiting approval; funder approves; capture runs; success | "The funder approves one order. One capture pays the seller and the platform." |
| 1:06 | Seller advance and platform fee, each with its capture id | "Two purchase units, two accounts, one payment. No platform balance is created." |
| 1:12 | Conditional — only if this book has a notice: the notice of assignment, then the service register row (channel, reference, digest). If no invoice reached fully funded, cut this row. | "The moment the paper is owned outright the debtor is told who holds it. The register is append-only, and the page says what it does not prove: that it arrived." |
| 1:20 | NW-2277 showing **Due, awaiting debtor** with its order id, then the measured three-way split from the repo evidence, labelled **sandbox replay** | "At maturity the debtor pays once: principal, yield, the seller's remainder and the fee, as purchase units of one order. That shape is measured, and the capture ids are in the repo." |
| 1:34 | A refund event resolves to its invoice; position freezes | "If the rail reports a refund, the position freezes itself." |
| 1:42 | Archive, by reason, with the two refusal rows a seller cannot fake: the same parcel on two invoices, and the same document twice | "Every refusal carries a reason the seller can act on. The count is on the page — read it from the page, never from the script." |
| 1:56 | Final card | "Not escrow, not a lender, not a marketplace. Sandbox only." |

**Do not say**

- "Escrow", "we hold the money", "guaranteed", "protected by PayPal" — the build takes no custody
  and the sandbox returns no protection status.
- Any number not on screen at that moment.

**Timing budget:** 2:04 scripted, 2:10 ceiling. The free reader's one-minute window is the only
external dependency; the model card is opened, not triggered, during the take. If the dry run breaks
the ceiling, cut in this order: the refund beat, then the register sentence at 1:12 (keep the notice
itself), then the two-fraud-rows sentence at 1:42 — never the refusal, the two-reader table or the
live funding.
