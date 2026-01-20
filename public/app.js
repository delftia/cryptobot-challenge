const qs = (id) => document.getElementById(id);

const state = {
  auto: false,
  timer: null,
  logs: [],
  maxLogs: 200,
};

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
  const el = qs(id);
  if (!el) return;
  el.textContent = typeof obj === 'string' ? obj : pretty(obj);
}

function log(line, extra) {
  const ts = new Date().toLocaleTimeString();
  const msg = extra ? `${ts} | ${line} | ${typeof extra === 'string' ? extra : pretty(extra)}` : `${ts} | ${line}`;
  state.logs.push(msg);
  if (state.logs.length > state.maxLogs) state.logs.shift();
  const box = qs('logs');
  if (box) box.textContent = state.logs.join('\n');
  console.log('[UI]', line, extra ?? '');
}

async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const t0 = performance.now();

  log(`API → ${method} ${path}`);

  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  const ms = Math.round(performance.now() - t0);
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
    log(`API ✗ ${method} ${path} (${res.status}) ${ms}ms`, data);
    throw new Error(`${msg}${details}`);
  }

  log(`API ✓ ${method} ${path} (${res.status}) ${ms}ms`);
  return data;
}

async function refreshAll() {
  const auctionId = qs('auctionId')?.value.trim();
  if (!auctionId) return;

  const a = await api(`/api/auctions/${auctionId}`);
  setBox('auctionBox', a.auction);

  const lb = await api(`/api/auctions/${auctionId}/leaderboard?limit=50`);
  const lbText = lb
    .map((b, idx) => {
      const u = b.userId?.username ? `${b.userId.username}` : String(b.userId);
      return `${String(idx + 1).padStart(2, '0')}. ${u} | entry=${b.entryId} | bid=${b.amountCents} (${centsToMoney(
        b.amountCents
      )}) | last=${new Date(b.lastBidAt).toLocaleTimeString()}`;
    })
    .join('\n');
  setBox('leaderboard', lbText || '(пусто)');

  const w = await api(`/api/auctions/${auctionId}/winners?limit=200`);
  const wText = w
    .map((x) => {
      const u = x.userId?.username ? `${x.userId.username}` : String(x.userId);
      return `#${x.giftNumber} | ${u} | entry=${x.entryId} | paid=${x.amountCents} (${centsToMoney(x.amountCents)}) | round=${x.round}`;
    })
    .join('\n');
  setBox('winners', wText || '(победителей пока нет)');

  const bots = await api(`/api/auctions/${auctionId}/bots`);
  setBox('botsBox', bots);

  renderTick(a.auction);
}

function renderTick(auction) {
  const el = qs('tick');
  if (!el) return;

  if (!auction || auction.status !== 'running' || !auction.currentRoundEndsAt) {
    el.textContent = '';
    return;
  }

  const end = new Date(auction.currentRoundEndsAt).getTime();
  const now = Date.now();
  const leftMs = Math.max(0, end - now);
  const left = Math.ceil(leftMs / 1000);
  const ext = auction.currentRoundExtendedBySec ? ` (+${auction.currentRoundExtendedBySec}s)` : '';

  if (auction.settling) {
    el.textContent = `Раунд #${auction.currentRound}: идёт подведение итогов (settlement)…${ext} | осталось предметов: ${auction.remainingItems}`;
    return;
  }

  if (left === 0) {
    el.textContent = `Раунд #${auction.currentRound}: время вышло, ожидаем подведение итогов…${ext} | осталось предметов: ${auction.remainingItems}`;
    return;
  }

  el.textContent = `Раунд #${auction.currentRound} закончится через ${left}s${ext} | осталось предметов: ${auction.remainingItems}`;
}

function startAuto() {
  if (state.timer) return;
  state.timer = setInterval(() => {
    refreshAll().catch((e) => log('refresh error', e.message));
  }, 1000);
  state.auto = true;
  log('Автообновление: ВКЛ');
}

function stopAuto() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.auto = false;
  const t = qs('tick');
  if (t) t.textContent = '';
  log('Автообновление: ВЫКЛ');
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
      toast('Пользователь создан');
      log('user created', u);
    } catch (e) {
      toast(e.message);
      log('user create failed', e.message);
    }
  };

  qs('loadUser').onclick = async () => {
    try {
      const id = qs('userId').value.trim();
      const u = await api(`/api/users/${id}`);
      setBox('userBox', u);
      toast('Пользователь загружен');
      log('user loaded', u);
    } catch (e) {
      toast(e.message);
      log('user load failed', e.message);
    }
  };

  qs('doTopup').onclick = async () => {
    try {
      const id = qs('userId').value.trim();
      const amountCents = Number(qs('topup').value);
      const u = await api(`/api/users/${id}/topup`, { method: 'POST', body: JSON.stringify({ amountCents }) });
      setBox('userBox', u);
      toast('Баланс пополнен');
      log('topup ok', { userId: id, amountCents });
    } catch (e) {
      toast(e.message);
      log('topup failed', e.message);
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
      toast('Аукцион создан');
      log('auction created', a);
    } catch (e) {
      toast(e.message);
      log('auction create failed', e.message);
    }
  };

  qs('startAuction').onclick = async () => {
    try {
      const id = qs('auctionId').value.trim();
      const a = await api(`/api/auctions/${id}/start`, { method: 'POST' });
      setBox('auctionBox', a);
      toast('Аукцион запущен');
      log('auction started', a);
      await refreshAll();
    } catch (e) {
      toast(e.message);
      log('auction start failed', e.message);
    }
  };

  qs('loadAuction').onclick = async () => {
    try {
      const id = qs('auctionId').value.trim();
      const a = await api(`/api/auctions/${id}`);
      setBox('auctionBox', a.auction);
      toast('Аукцион загружен');
      log('auction loaded', a.auction);
      await refreshAll();
    } catch (e) {
      toast(e.message);
      log('auction load failed', e.message);
    }
  };

  qs('placeBid').onclick = async () => {
    try {
      const auctionId = qs('auctionId').value.trim();
      const userId = qs('userId').value.trim();
      const entryId = qs('entryId').value.trim() || undefined;
      const amountCents = Number(qs('bidCents').value);

      const out = await api(`/api/auctions/${auctionId}/bids`, {
        method: 'POST',
        body: JSON.stringify({ userId, entryId, amountCents }),
      });

      toast(`Ставка OK: ${out.bidCents}`);
      log('bid ok', out);

      await api(`/api/users/${userId}`).then((u) => setBox('userBox', u));
      await refreshAll();
    } catch (e) {
      toast(e.message);
      log('bid failed', e.message);
    }
  };

  qs('toggleAuto').onclick = async () => {
    if (state.auto) {
      stopAuto();
      toast('Автообновление: выкл');
    } else {
      startAuto();
      toast('Автообновление: вкл');
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
      toast('Боты запущены');
      log('bots started', out);
    } catch (e) {
      toast(e.message);
      log('bots start failed', e.message);
    }
  };

  qs('botsStop').onclick = async () => {
    try {
      const auctionId = qs('auctionId').value.trim();
      const out = await api(`/api/auctions/${auctionId}/bots/stop`, { method: 'POST' });
      setBox('botsBox', out);
      toast('Боты остановлены');
      log('bots stopped', out);
    } catch (e) {
      toast(e.message);
      log('bots stop failed', e.message);
    }
  };
}

bind();
log('UI готов. Открой DevTools → Console для подробностей.');
refreshAll().catch(() => {});
