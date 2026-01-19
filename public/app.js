const qs = (id) => document.getElementById(id);

const state = {
  auto: false,
  timer: null,
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = data?.error || res.statusText;
    const details = data?.details ? `\n${JSON.stringify(data.details, null, 2)}` : '';
    throw new Error(`${msg}${details}`);
  }
  return data;
}

function pretty(obj) {
  return JSON.stringify(obj, null, 2);
}

function centsToMoney(cents) {
  if (typeof cents !== 'number') return '';
  const sign = cents < 0 ? '-' : '';
  const n = Math.abs(cents);
  const euros = Math.floor(n / 100);
  const rest = String(n % 100).padStart(2, '0');
  return `${sign}${euros}.${rest}`;
}

function setBox(id, obj) {
  qs(id).textContent = typeof obj === 'string' ? obj : pretty(obj);
}

async function refreshAll() {
  const auctionId = qs('auctionId').value.trim();
  if (!auctionId) return;

  const a = await api(`/api/auctions/${auctionId}`);
  setBox('auctionBox', a.auction);

  const lb = await api(`/api/auctions/${auctionId}/leaderboard?limit=50`);
  const lbText = lb
    .map((b, idx) => {
      const u = b.userId?.username ? `${b.userId.username}` : String(b.userId);
      return `${String(idx + 1).padStart(2, '0')}. ${u} | entry=${b.entryId} | bid=${b.amountCents} (${centsToMoney(b.amountCents)}) | last=${new Date(b.lastBidAt).toLocaleTimeString()}`;
    })
    .join('\n');
  setBox('leaderboard', lbText || '(empty)');

  const w = await api(`/api/auctions/${auctionId}/winners?limit=200`);
  const wText = w
    .map((x) => {
      const u = x.userId?.username ? `${x.userId.username}` : String(x.userId);
      return `#${x.giftNumber} | ${u} | entry=${x.entryId} | paid=${x.amountCents} (${centsToMoney(x.amountCents)}) | round=${x.round}`;
    })
    .join('\n');
  setBox('winners', wText || '(no winners yet)');

  const bots = await api(`/api/auctions/${auctionId}/bots`);
  setBox('botsBox', bots);

  renderTick(a.auction);
}

function renderTick(auction) {
  if (!auction || auction.status !== 'running' || !auction.currentRoundEndsAt) {
    qs('tick').textContent = '';
    return;
  }
  const end = new Date(auction.currentRoundEndsAt).getTime();
  const now = Date.now();
  const leftMs = Math.max(0, end - now);
  const left = Math.ceil(leftMs / 1000);
  const ext = auction.currentRoundExtendedBySec ? ` (+${auction.currentRoundExtendedBySec}s)` : '';
  qs('tick').textContent = `Round #${auction.currentRound} ends in ${left}s${ext} | remaining items: ${auction.remainingItems}`;
}

function startAuto() {
  if (state.timer) return;
  state.timer = setInterval(() => {
    refreshAll().catch((e) => console.warn(e));
  }, 1000);
  state.auto = true;
}

function stopAuto() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.auto = false;
  qs('tick').textContent = '';
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, 2500);
}

function bind() {
  qs('createUser').onclick = async () => {
    try {
      const username = qs('username').value.trim();
      const u = await api('/api/users', { method: 'POST', body: JSON.stringify({ username }) });
      qs('userId').value = u._id;
      setBox('userBox', u);
      toast('User created');
    } catch (e) {
      toast(e.message);
    }
  };

  qs('loadUser').onclick = async () => {
    try {
      const id = qs('userId').value.trim();
      const u = await api(`/api/users/${id}`);
      setBox('userBox', u);
      toast('User loaded');
    } catch (e) {
      toast(e.message);
    }
  };

  qs('doTopup').onclick = async () => {
    try {
      const id = qs('userId').value.trim();
      const amountCents = Number(qs('topup').value);
      const u = await api(`/api/users/${id}/topup`, { method: 'POST', body: JSON.stringify({ amountCents }) });
      setBox('userBox', u);
      toast('Topup OK');
    } catch (e) {
      toast(e.message);
    }
  };

  qs('createAuction').onclick = async () => {
    try {
      const body = {
        title: qs('title').value.trim(),
        totalItems: Number(qs('totalItems').value),
        itemsPerRound: Number(qs('itemsPerRound').value),
        roundDurationSec: Number(qs('roundDurationSec').value),
        minBidCents: Number(qs('minBidCents').value),
        antiSnipeWindowSec: Number(qs('antiWindow').value),
        antiSnipeExtensionSec: Number(qs('antiExt').value),
        antiSnipeMaxTotalExtensionSec: Number(qs('antiMax').value),
      };
      const a = await api('/api/auctions', { method: 'POST', body: JSON.stringify(body) });
      qs('auctionId').value = a._id;
      setBox('auctionBox', a);
      toast('Auction created');
    } catch (e) {
      toast(e.message);
    }
  };

  qs('startAuction').onclick = async () => {
    try {
      const id = qs('auctionId').value.trim();
      const a = await api(`/api/auctions/${id}/start`, { method: 'POST' });
      setBox('auctionBox', a);
      toast('Auction started');
      await refreshAll();
    } catch (e) {
      toast(e.message);
    }
  };

  qs('loadAuction').onclick = async () => {
    try {
      const id = qs('auctionId').value.trim();
      const a = await api(`/api/auctions/${id}`);
      setBox('auctionBox', a.auction);
      toast('Auction loaded');
      await refreshAll();
    } catch (e) {
      toast(e.message);
    }
  };

  qs('placeBid').onclick = async () => {
    try {
      const auctionId = qs('auctionId').value.trim();
      const userId = qs('userId').value.trim();
      const entryId = qs('entryId').value.trim() || undefined;
      const amountCents = Number(qs('bidCents').value);
      const out = await api(`/api/auctions/${auctionId}/bids`, { method: 'POST', body: JSON.stringify({ userId, entryId, amountCents }) });
      toast(`Bid OK: ${out.bidCents}`);
      await api(`/api/users/${userId}`).then((u) => setBox('userBox', u));
      await refreshAll();
    } catch (e) {
      toast(e.message);
    }
  };

  qs('toggleAuto').onclick = async () => {
    if (state.auto) {
      stopAuto();
      toast('Auto-refresh stopped');
    } else {
      startAuto();
      toast('Auto-refresh started');
    }
  };

  qs('botsStart').onclick = async () => {
    try {
      const auctionId = qs('auctionId').value.trim();
      const count = Number(qs('botCount').value);
      const maxBidCents = Number(qs('botMaxBid').value);
      const intervalMs = Number(qs('botInterval').value);
      const usernamePrefix = qs('botPrefix').value.trim() || 'bot';
      const out = await api(`/api/auctions/${auctionId}/bots/start`, {
        method: 'POST',
        body: JSON.stringify({ count, maxBidCents, intervalMs, usernamePrefix }),
      });
      setBox('botsBox', out);
      toast('Bots started');
    } catch (e) {
      toast(e.message);
    }
  };

  qs('botsStop').onclick = async () => {
    try {
      const auctionId = qs('auctionId').value.trim();
      const out = await api(`/api/auctions/${auctionId}/bots/stop`, { method: 'POST' });
      setBox('botsBox', out);
      toast('Bots stopped');
    } catch (e) {
      toast(e.message);
    }
  };
}

bind();
refreshAll().catch(() => {});
