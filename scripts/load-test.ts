/**
 * Load / concurrency test for the auction.
 *
 * What it does:
 * 1) Creates N users and tops them up
 * 2) Creates + starts an auction
 * 3) Sends concurrent bid increases (including near end-of-round)
 * 4) Prints invariants periodically and at the end
 *
 * Usage (with docker-compose running):
 *   npm run load
 */

import pLimit from 'p-limit';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';

const cfg = {
  users: Number(process.env.USERS ?? 200),
  concurrency: Number(process.env.CONCURRENCY ?? 50),
  runtimeSec: Number(process.env.RUNTIME_SEC ?? 90),
  topupCents: Number(process.env.TOPUP_CENTS ?? 1_000_000),
  maxBidCents: Number(process.env.MAX_BID_CENTS ?? 50_000),
  roundDurationSec: Number(process.env.ROUND_DURATION_SEC ?? 30),
  totalItems: Number(process.env.TOTAL_ITEMS ?? 300),
  itemsPerRound: Number(process.env.ITEMS_PER_ROUND ?? 30),
  antiWindowSec: Number(process.env.ANTI_WINDOW_SEC ?? 5),
  antiExtSec: Number(process.env.ANTI_EXT_SEC ?? 5),
  antiMaxSec: Number(process.env.ANTI_MAX_SEC ?? 20),
};

async function http(path: string, options: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error ?? `${res.status}`;
    throw new Error(msg);
  }
  return body;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('Load test config:', cfg);
  await http('/api/health');

  // Create users
  console.log(`Creating ${cfg.users} users...`);
  const limit = pLimit(cfg.concurrency);
  const users: { id: string; username: string }[] = [];

  await Promise.all(
    Array.from({ length: cfg.users }).map((_, i) =>
      limit(async () => {
        const u = await http('/api/users', {
          method: 'POST',
          body: JSON.stringify({ username: `load_${i}_${Date.now()}` }),
        });
        await http(`/api/users/${u._id}/topup`, {
          method: 'POST',
          body: JSON.stringify({ amountCents: cfg.topupCents }),
        });
        users.push({ id: u._id, username: u.username });
      })
    )
  );

  // Create + start auction
  const auction = await http('/api/auctions', {
    method: 'POST',
    body: JSON.stringify({
      title: `LOAD_${Date.now()}`,
      totalItems: cfg.totalItems,
      itemsPerRound: cfg.itemsPerRound,
      roundDurationSec: cfg.roundDurationSec,
      minBidCents: 1,
      antiSnipeWindowSec: cfg.antiWindowSec,
      antiSnipeExtensionSec: cfg.antiExtSec,
      antiSnipeMaxTotalExtensionSec: cfg.antiMaxSec,
    }),
  });

  await http(`/api/auctions/${auction._id}/start`, { method: 'POST' });
  console.log('Auction started:', auction._id);

  // Track each user's current bid to always increase.
  const bids = new Map<string, number>();

  const start = Date.now();
  let ops = 0;
  let errors = 0;

  async function tick() {
    const a = await http(`/api/auctions/${auction._id}`);
    const endsAt = a?.auction?.currentRoundEndsAt ? new Date(a.auction.currentRoundEndsAt).getTime() : 0;
    const msLeft = Math.max(0, endsAt - Date.now());

    // Try to snipe in the last 400ms of round.
    const snipeMode = msLeft > 0 && msLeft < 400;

    const batch = Array.from({ length: cfg.concurrency }).map(() =>
      limit(async () => {
        const u = users[Math.floor(Math.random() * users.length)]!;
        const prev = bids.get(u.id) ?? 0;
        const next = Math.min(cfg.maxBidCents, prev + 1 + Math.floor(Math.random() * 50));
        bids.set(u.id, next);
        try {
          await http(`/api/auctions/${auction._id}/bids`, {
            method: 'POST',
            body: JSON.stringify({ userId: u.id, amountCents: next, entryId: 'default' }),
          });
          ops += 1;
        } catch {
          errors += 1;
        }
      })
    );

    await Promise.all(batch);

    if (snipeMode) {
      // Extra burst to stress anti-sniping + concurrency
      await Promise.all(
        Array.from({ length: cfg.concurrency }).map(() =>
          limit(async () => {
            const u = users[Math.floor(Math.random() * users.length)]!;
            const prev = bids.get(u.id) ?? 0;
            const next = Math.min(cfg.maxBidCents, prev + 100);
            bids.set(u.id, next);
            try {
              await http(`/api/auctions/${auction._id}/bids`, {
                method: 'POST',
                body: JSON.stringify({ userId: u.id, amountCents: next, entryId: 'default' }),
              });
              ops += 1;
            } catch {
              errors += 1;
            }
          })
        )
      );
    }

    // Print invariants occasionally
    if ((Date.now() - start) % 5000 < 200) {
      const inv = await http(`/api/auctions/${auction._id}/invariants`);
      console.log(
        `[t+${Math.floor((Date.now() - start) / 1000)}s] round=${a.auction.currentRound} remaining=${a.auction.remainingItems} endsAt=${a.auction.currentRoundEndsAt} ext=${a.auction.currentRoundExtendedBySec}s inv_ok=${inv.ok} ops=${ops} err=${errors}`
      );
      if (!inv.ok) {
        console.log('Invariant mismatch sample:', inv.mismatch?.slice?.(0, 5));
      }
    }
  }

  while (Date.now() - start < cfg.runtimeSec * 1000) {
    await tick();
    await sleep(50);
  }

  // Final check
  const finalInv = await http(`/api/auctions/${auction._id}/invariants`);
  const final = await http(`/api/auctions/${auction._id}`);
  console.log('FINAL:', {
    auctionId: auction._id,
    status: final.auction.status,
    round: final.auction.currentRound,
    remaining: final.auction.remainingItems,
    ops,
    errors,
    invariantOk: finalInv.ok,
  });
}

main().catch((e) => {
  console.error('Load test failed:', e);
  process.exit(1);
});
