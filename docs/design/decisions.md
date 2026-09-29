# Decision register

Status: **Awaiting owner input** · Last updated: 2026-09-29

This register lists the decisions behind [multi-client-design.md](./multi-client-design.md) and [implementation-plan.md](./implementation-plan.md). The existing codebase is treated as **reference, not constraint**: where a better choice exists for the new clients, we take it.

Decisions fall into three buckets:

| Bucket | Meaning | What you do |
|--------|---------|-------------|
| **A. One-way doors — need your go-ahead** | Expensive or impossible to reverse (permanent identifiers, data formats others depend on, irreversible disclosure, the tech stack). | Reply with a choice (or "go with recommendation") per item. Work that depends on an item waits. |
| **B. Decided, hard to reverse, low controversy** | Clear best practice. Proceeding unless you object. | Veto if you disagree. |
| **C. Two-way doors — decided** | Cheap to change later; hidden behind interfaces. | Nothing, unless curious. |

Quick reply format (from your phone): `A1: <name>, A2: rec, A3: rec, A4: rec, A5: rec, A6: rec, A7: rec, A8: rec`.

---

## A. One-way doors (need your go-ahead)

### A1. App identity: name, bundle ID, iCloud container, Apple account type

- **Why it's one-way.** A bundle ID can never change for an App Store Connect app record. CloudKit container IDs can't be renamed or deleted. The account type (Individual vs Organization) determines the seller name and is a manual migration with Apple to change.
- **Proposal.**
  - Apple account: **Individual** (fastest to enroll from iPhone; no D-U-N-S number).
  - Bundle ID: `io.github.rohitnandwate.<appslug>` (Mac + iOS share one ID via a multiplatform target).
  - iCloud container: `iCloud.io.github.rohitnandwate.<appslug>`
  - App Group: `group.io.github.rohitnandwate.<appslug>` (widgets).
- **Needed from you.** An app name/slug (working title in docs: "Local Finances", slug `localfinances`).
- **Blocks.** Plan task 0.4 (first TestFlight build).

### A2. Client technology stack

The biggest decision. It sets the languages, how fast you can iterate from a phone, and how "native" the apps feel.

| Option | What it is | Pros | Cons |
|--------|------------|------|------|
| **A2-1. SwiftUI (iOS + macOS) + TypeScript web** *(recommended)* | One SwiftUI multiplatform app; a separate React PWA; business logic implemented in Swift and TS against one spec + shared test fixtures. | Truly native on both Apple platforms, including the Mac. First-class Keychain + biometrics, Data Protection, CloudKit end-to-end encryption, on-device Apple Foundation Models (private offline classification), widgets, Shortcuts. Swift core tests run on Linux, so agents can test logic without a Mac. | Two codebases (Swift + TS) and UI built twice. Every iOS UI check needs macOS CI (~10–20 min) and a TestFlight build (~30–60 min) to reach your phone. |
| A2-2. Expo / React Native (iOS + web from one codebase) | One TypeScript app; iOS via React Native, web via react-native-web; Mac via "Designed for iPad" or react-native-macos. | One language and mostly one UI. EAS builds iOS in the cloud and submits to TestFlight without a Mac; **over-the-air updates reach your phone in minutes**, which is a big win while you're phone-only. | The Mac app would not be genuinely native (iPad app on Mac, or a less mature react-native-macos). CloudKit and Foundation Models need custom native modules. More third-party dependency surface for a finance app. EAS paid tier likely needed. |
| A2-3. Rust core + SwiftUI + web | Logic written once in Rust, bound to Swift (UniFFI) and web (WASM). | Single source of truth for logic. | Still two UIs; adds a third language and FFI build complexity on macOS CI; slowest for agents to iterate. |

- **Recommendation: A2-1.** You asked for native macOS and iOS apps; A2-1 is the only option that delivers a native Mac app and full access to the Apple privacy features that matter for a finance app. The iteration-speed cost is mostly temporary (while you have no laptop), and it's mitigated by keeping logic in a Linux-testable Swift package and using demo-mode screenshots in every PR.
- **Pick A2-2 instead if** iteration speed from your phone matters more than a native Mac experience.
- **Blocks.** Everything after Phase 0 scaffolding.

### A3. Distribution scope

| Option | Implication |
|--------|-------------|
| **A3-1. Personal only** *(recommended for v1)*: TestFlight internal testing + open source for self-builders | Direct mode (your Plaid keys on your own devices) is acceptable. No App Review privacy obligations beyond TestFlight. No project-operated servers. |
| A3-2. Public App Store app | Plaid secret **must** live on a server (Relay becomes mandatory and project-operated); Plaid production approval for a consumer app; privacy policy, account deletion, support, App Review for a finance app; multi-tenant concerns. |

- **Why it's one-way-ish.** Going public later is possible, but a public release creates obligations (hosted relay, data handling promises) that are hard to walk back.
- **Recommendation: A3-1.** Revisit after v1.

### A4. Category taxonomy

- **Change from the current app.** Today everything is keyed on Plaid's PFC categories.
- **Proposal.** Our **own two-level taxonomy** (~14 groups, ~70 categories) with stable slug IDs (for example `food.coffee`), user-editable labels and descriptions, and **custom categories** supported from day one. Plaid's PFC becomes an *input signal* mapped onto our taxonomy, not the storage format.
- **Why it's one-way.** Rules, budgets, overrides, history, sync records, and the classifier's option list all reference category IDs. Changing the scheme later means migrating every one of those, on every device.
- **Why change.** PFC is Plaid's taxonomy, tuned for Plaid's needs (e.g. `GENERAL_MERCHANDISE` is broad; no "Kids", "Pets", or "Reimbursable"). Owning the taxonomy decouples us from the bank data provider (A8) and is the strongest reason to use Jev at all (Plaid can't classify into your categories).
- **Also.** ~70 categories fits comfortably under Jev's ~240-option reliable limit in one question.
- **Recommendation: own taxonomy.** The agent drafts it as `spec/taxonomy.json` for your review before anything depends on it.

### A5. Sending real transaction data to cloud AI (Jev, LLMs)

- **Why it's one-way.** Disclosure can't be undone. Once transaction text reaches TypeSafe (US processing, retention unspecified, no zero-retention outside enterprise) or an LLM provider, it's out of your control.
- **Proposal.**
  1. Phase 0 evaluation uses **synthetic and Plaid Sandbox data only**.
  2. Real data goes to Jev only if the evaluation passes (design §8.6) **and** you opt in.
  3. Minimized payload: merchant name, cleaned description, channel, direction, amount bucket, Plaid's category hint. **Never**: account numbers or names, exact amounts, dates, locations beyond city, notes.
  4. LLM chat sends only your question, aggregate metrics, and the rows its SQL returns, never the full database.
- **Needed from you.** Go / no-go on this policy, and whether exact amounts may ever be included.

### A6. Cross-device sync design

- **Why it's one-way.** A CloudKit production schema is permanent: record types and fields can never be deleted or renamed. Container IDs are permanent. Data formats spread across devices are hard to change.
- **Options.**

| Option | Summary |
|--------|---------|
| **A6-1. Encrypted change log over CloudKit** *(recommended)* | User-authored changes (rules, overrides, budgets, categories, settings) are written as small encrypted change records. **One generic CloudKit record type** carries an opaque encrypted payload. The CloudKit schema never needs to change, and the same change-log format could later sync through another store (e.g. a file in iCloud Drive or an S3 bucket) so the web client can participate. |
| A6-2. Typed CloudKit records (one record type per entity) | Idiomatic, but every schema mistake is permanent and web can never join. |
| A6-3. No sync | Each device is independent; manual backup/restore only. |

- **Sub-decision.** Should transactions themselves sync between devices (then only one device needs Plaid access), or should each device pull from Plaid on its own? **Recommendation: each device pulls from Plaid** (simpler; Plaid bills per Item, not per call). Transaction sync can be added later on the same change log.
- **Recommendation: A6-1**, user-authored data only.

### A7. Where the Plaid secret lives on native

| Option | Summary |
|--------|---------|
| **A7-1. Direct mode** *(recommended if A3-1)* | Your Plaid `client_id` + `secret` stored in Keychain on your devices, behind Face ID. Zero servers. |
| A7-2. Relay mode | A stateless serverless Relay you deploy (your own Vercel account) holds the secret. |

- **Why it's one-way-ish.** Switching modes later is easy technically (Plaid Items belong to your Plaid account, not to a transport). But a leaked production secret is an irreversible exposure. It can be rotated, but only after the fact.
- **Recommendation: A7-1 for personal builds**, with the Relay available as a setting. The web client always uses the Relay.

### A8. Bank data provider

| Option | Summary |
|--------|---------|
| **A8-1. Plaid** *(recommended; your stated preference)* | Richest data (merchant names, logos, categories with confidence, counterparties), up to 24 months history, on-demand refresh. Needs a secret (A7). Per-Item pricing. |
| A8-2. SimpleFIN Bridge | $15/yr, user-owned access URL, **no developer secret, so no server needed at all**. But: no merchant enrichment or categories, 90-day request windows, data refreshes about once a day, ~24 requests/day. |

- **Why it's one-way-ish.** Transaction IDs and history continuity are tied to the provider; switching later means re-linking and reconciling history.
- **Recommendation: A8-1 (Plaid)**, behind a `BankDataProvider` interface so SimpleFIN could be added later as a secondary option for accounts or users who want a strictly serverless path.

---

## B. Decided — hard to reverse, low controversy (veto if you disagree)

| ID | Decision | Why |
|----|----------|-----|
| B1 | **Clean-slate rebuild.** The legacy Express app is reference material, not a compatibility target or test oracle. It moves to `legacy/` and is deleted once the new clients reach parity. Algorithms (transfers, recurring, rules) are re-specified and may improve. | Avoids inheriting JSON-blob storage, TSV/DuckDB analytics, and PFC coupling. |
| B2 | **No migration of legacy transaction data.** Re-link banks in the new apps (Plaid returns up to 24 months). An optional importer carries over **merchant rules and budgets only**. | Legacy transaction overrides are keyed to Plaid IDs that change on re-link; rules are what hold the learning. |
| B3 | **Money is stored as signed integer minor units** (cents) + ISO currency code; **negative = money out**. Plaid's sign (positive = outflow) is flipped at ingestion. | Avoids floating-point drift in sums; matches common accounting convention. |
| B4 | **Our own stable IDs** (UUIDv7) for accounts and transactions, alongside provider IDs, plus a **fingerprint** (account mask, date, amount, normalized description) that re-attaches user edits after a re-link or provider change. | Plaid transaction IDs change on re-link; user edits must survive. |
| B5 | **Request maximum history at link time** (730 days). | Plaid fixes the history window per Item at link time; extending it requires re-linking. |
| B6 | **SQLite is the on-device store on every client.** | One schema, SQL analytics, mature on Apple and web (SQLite-WASM + OPFS). |
| B7 | **Minimum OS: iOS 26 / macOS 26.** | Personal app; enables Apple Foundation Models and current SwiftUI APIs. Lowering later would be hard, raising is easy. |
| B8 | **No LLM in the classification path by default.** Low-confidence cases go to you, not a bigger model. | Keeps data exposure, cost, and non-determinism down; revisit only if the evaluation shows a large unresolved band. |

---

## C. Two-way doors — decided

| Area | Choice |
|------|--------|
| Apple persistence library | GRDB (behind a repository layer) |
| Xcode project | XcodeGen `project.yml` (text, agent-editable) |
| Web framework | React + Vite PWA, SQLite-WASM (OPFS SAH-pool VFS) |
| Relay hosting | Vercel Functions (Cloudflare Workers equally fine) |
| Classifier vendor | Jev behind a `TransactionClassifier` interface; Plaid hint, rules, memory, on-device model as fallbacks |
| Thresholds, roll-up, review routing | Tuned from evaluation data |
| LLM provider for chat/briefings | Any Vercel AI SDK–compatible provider; BYO key or via Relay |
| Web at-rest encryption | Optional passphrase |
| CI | GitHub Actions (Linux + macOS runners), TestFlight via App Store Connect API key |
| UI information architecture, design tokens | As in design §10; iterated with screenshots |

---

## Log

| Date | Decision | Outcome |
|------|----------|---------|
| 2026-09-29 | Register created | Awaiting owner input on A1–A8 |
