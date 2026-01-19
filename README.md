# Telegram Gift Auctions-inspired backend (Contest Project)

This repository implements a **multi-round auction for digital goods**, inspired by **Telegram Gift Auctions**.

- **Stack (core):** Node.js, TypeScript, MongoDB
- **Focus:** financial correctness, concurrent requests safety, edge-cases, anti-sniping, and clear reasoning
- **Deliverables:** backend API, minimal UI, demo bots, load test scripts, Docker compose

> ⚠️ This project is designed for a contest environment: rules are reconstructed from public behavior and official announcements. Where Telegram does not specify exact behavior (notably anti-sniping), the behavior is **explicitly parameterized** and documented.

---

## Sources / What Telegram Gift Auctions are

Telegram officially describes Gift Auctions as:
- auctions for limited digital gifts
- **multi-round** (not a single deadline)
- in each round, a subset of top bidders receive the items; the rest continue

**Official sources:**
- Telegram Blog post (Nov 19, 2025): https://telegram.org/blog/live-stories-gift-auctions
- Example auction reference (Khabib’s Papakha): Pavel Durov post: https://t.me/s/Durov/4450 and the auction itself: https://t.me/auction/KhabibsPapakha

**Observed example facts (Khabib’s Papakha):** 29,000 items, 290 rounds, 5 minutes each, 100 items per round.

---

## Our auction spec (reconstructed)

### Core mechanics
- An auction has `totalItems` to distribute.
- Auction runs in **rounds** of `roundDurationSec` seconds.
- Each round awards up to `itemsPerRound` items to the **top bidders**.
- Ranking uses:
  1) `bid amount desc` (highest bid wins)
  2) `lastBidAt asc` (earlier bid wins in a tie)
- Winners of the round **exit** the auction for that entry.
- Losers continue with their bids to the next round.
- When all items are distributed, all remaining active bids are **refunded**.

### Gift numbering
Telegram’s UI shows gift numbers (e.g., №1..№N). Telegram assigns numbers according to place.

In this implementation:
- Gift numbers are assigned **sequentially** for the auction: 1..`totalItems`.
- In each round, the highest bidder gets the next gift number, etc.

### Money semantics
We model money in **integer cents** (no floats).

- User wallet:
  - `availableCents`
  - `reservedCents`
- When a user increases bid from `prev` to `new`:
  - reserve **delta** (`new - prev`)
- If user wins:
  - `reservedCents -= bid` (charged)
- If auction ends and user did not win:
  - `reservedCents -= bid`, `availableCents += bid` (refunded)

All operations are recorded in a **ledger** for auditing.

### Anti-sniping (parameterized)
Telegram mentions anti-sniping but does not publish exact numbers.

This project implements configurable anti-sniping:
- If a bid comes within the last `antiSnipeWindowSec` seconds of a round,
  extend the round by `antiSnipeExtensionSec` seconds,
  up to `antiSnipeMaxTotalExtensionSec` seconds total extension in that round.
- `antiSnipeMaxTotalExtensionSec = 0` means **unlimited** extension.

---

## Architecture

### Collections (MongoDB)
- `users`: wallet balances
- `ledger`: immutable money operations log
- `auctions`: auction state + round timer + settlement lock
- `bids`: active bids per (auctionId, userId, entryId)
- `winners`: round winners with gift numbers

### Concurrency & correctness
- All money and bidding operations use **MongoDB transactions**.
- Round settlement uses a **distributed lock** stored in the auction document (`settling`, `settlingLockId`, `settlingAt`).
- Stale locks are auto-cleared after 2 minutes.

Key invariants:
- No negative balances.
- Sum of all active bids equals sum of reserved balances for those users.

An endpoint `/api/auctions/:id/invariants` is provided for quick verification.

---

## Run locally (Docker)

```bash
docker compose up --build
```

Then open:
- UI: http://localhost:3000
- Health: http://localhost:3000/api/health

> MongoDB is started as a **replica set** (required for transactions).

---

## Run locally (without Docker)

Requirements:
- Node.js 20+ (recommended 22)
- MongoDB replica set enabled

```bash
cp .env.example .env
npm install
npm run dev
```

---

## Minimal UI

The UI is intentionally simple:
- create/load user, topup
- create/load/start auction
- place bids
- see leaderboard and winners
- start/stop demo bots

---

## Load testing

A script is provided:

```bash
npm run load
```

It will:
- create an auction
- create N users, topup
- send many concurrent bids (including last-second bids)
- print invariants at the end

You can adjust variables inside `scripts/load-test.ts`.

---

## API summary

### Users
- `POST /api/users` `{ username }`
- `GET /api/users/:id`
- `POST /api/users/:id/topup` `{ amountCents }`
- `GET /api/users/:id/ledger?limit=100`

### Auctions
- `POST /api/auctions` (see UI fields)
- `POST /api/auctions/:id/start`
- `GET /api/auctions/:id`
- `GET /api/auctions/:id/leaderboard?limit=100`
- `GET /api/auctions/:id/winners?limit=200`
- `GET /api/auctions/:id/invariants`

### Bids
- `POST /api/auctions/:id/bids` `{ userId, amountCents, entryId? }`

### Demo bots
- `POST /api/auctions/:id/bots/start` `{ count, maxBidCents, intervalMs, usernamePrefix }`
- `POST /api/auctions/:id/bots/stop`

---

## Notes for contest submission
- Put this repo on GitHub.
- Record a short demo video:
  - create auction
  - start bots
  - show anti-sniping extension (bid near end)
  - show winners distribution by rounds
  - show invariants endpoint

