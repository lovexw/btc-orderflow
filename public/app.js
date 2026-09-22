/* ============================================================
   BTC Pulse — 实时订单流前端引擎
   数据链路：
     [Binance 公共镜像 WS] aggTrade + depth20 → 实时成交 / 盘口
        ↓ 失败自动切换
     [OKX WS] trades + books5（字段映射层归一）
        +
     REST /api/summary（Worker 多源聚合：资金费率 / 持仓量 / 24h 统计）
     REST /api/klines （K 线历史回补，Binance → OKX 容灾）
        ↓
     渲染：订单簿动画 / 成交流 / 买卖强度 / 巨鲸警报 / 观测任务 / Canvas 蜡烛图
   持久化：localStorage（积分 / 任务 / 巨鲸计数，按日重置）
   ============================================================ */

"use strict";

/* ---------------- 工具 ---------------- */

const $ = (id) => document.getElementById(id);

const fmtUsd = (n, d = 2) =>
  n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

function fmtCompact(n) {
  if (!isFinite(n)) return "--";
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return n.toFixed(0);
}

const fmtBtc = (n) => (n >= 100 ? n.toFixed(1) : n >= 1 ? n.toFixed(2) : n.toFixed(4));
const hhmmss = (ts) => new Date(ts).toTimeString().slice(0, 8);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---------------- 全局状态 ---------------- */

const S = {
  exchange: null,
  ws: null,
  wsAlive: false,
  lastMsgAt: 0,
  okxPing: null,

  spotPrice: null,
  prevPrice: null,
  chg24: null,

  bids: [],
  asks: [],
  mid: null,

  summary: null,
  summaryAt: 0,
  degraded: false,
  soundOn: false,

  tapeRows: [],
  whaleRows: [],
  whaleCountToday: 0,

  // 买卖强度：60 个秒槽环形缓冲，slot 记录所属秒，防止错位
  slots: Array.from({ length: 60 }, (_, i) => ({ sec: -1, buy: 0, sell: 0 })),

  // 图表
  tf: 5 * 60 * 1000,
  tfMin: 5,
  candles: [],
  candleSrc: null,

  // 会话统计（任务用）
  sessionTrades: 0,
  sessionUsd: 0,
  streak: 0,
  streakSide: null,

  // 游戏化
  score: 0,
  doneQuests: {},

  renderSec: null,
};

const QUEST_DEFS = [
  { id: "first_trade", icon: "⚡", name: "初见脉冲", desc: "捕获第一笔实时成交", reward: 10 },
  { id: "trades_100", icon: "📡", name: "数据洪流", desc: "累计观测 100 笔实时成交", reward: 30 },
  { id: "trades_1000", icon: "🌊", name: "弄潮儿", desc: "累计观测 1,000 笔实时成交", reward: 80 },
  { id: "whale_1", icon: "🐳", name: "初遇巨鲸", desc: "捕获第一笔 $100k+ 巨鲸单", reward: 50 },
  { id: "whale_5", icon: "🐋", name: "鲸群观察员", desc: "今日捕获 5 笔巨鲸单", reward: 120 },
  { id: "whale_500k", icon: "🛰️", name: "深潜者", desc: "捕获单笔 $500k+ 超级大单", reward: 150 },
  { id: "vol_1m", icon: "💰", name: "百万见证", desc: "累计见证 $1M 实时成交额", reward: 60 },
  { id: "streak_up", icon: "🚀", name: "多空猎人", desc: "见证连续 8 笔同方向成交", reward: 40 },
];

const WHALE_USD = 100000;
const LARGE_USD = 20000;

/* ---------------- 持久化 ---------------- */

const LS_KEY = "btc-pulse-save-v1";

function loadPersisted() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    S.score = d.score || 0;
    S.doneQuests = d.doneQuests || {};
    S.whaleCountToday = d.day === new Date().toDateString() ? d.whaleCountToday || 0 : 0;
  } catch { /* 忽略损坏数据 */ }
}

function savePersisted() {
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        score: S.score,
        doneQuests: S.doneQuests,
        whaleCountToday: S.whaleCountToday,
        day: new Date().toDateString(),
      })
    );
  } catch { /* 隐私模式忽略 */ }
}

/* ---------------- Toast & 提示条 ---------------- */

function toast(title, sub, gold = false) {
  const zone = $("toast-zone");
  const el = document.createElement("div");
  el.className = "toast" + (gold ? " gold" : "");
  el.innerHTML = `<span class="t-ico">${gold ? "🐳" : "💡"}</span><span class="t-body"><b></b><span></span></span>`;
  el.querySelector("b").textContent = title;
  el.querySelector("span").textContent = sub;
  zone.appendChild(el);
  while (zone.children.length > 4) zone.firstChild.remove();
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 320);
  }, gold ? 5200 : 3400);
}

function showAlert(msg, isErr = false) {
  const el = $("alert-strip");
  if (!msg) {
    el.className = "alert-strip";
    el.textContent = "";
    return;
  }
  el.className = "alert-strip show" + (isErr ? " err" : "");
  el.textContent = msg;
}

/* ---------------- 音效（WebAudio，无外部资源） ---------------- */

let audioCtx = null;
function beep(freq = 660, dur = 0.09, type = "sine", gain = 0.05) {
  if (!S.soundOn) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.value = gain;
    o.connect(g).connect(audioCtx.destination);
    const t = audioCtx.currentTime;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t);
    o.stop(t + dur + 0.02);
  } catch { /* 无声环境忽略 */ }
}

/* ---------------- WebSocket：双源容灾 ---------------- */

let reconnectDelay = 1000;
let sourceIndex = 0; // 0 = Binance 公共镜像, 1 = OKX

function wsConnect() {
  const useOkx = sourceIndex % 2 === 1;
  S.exchange = useOkx ? "okx" : "binance";
  const url = useOkx
    ? "wss://ws.okx.com:8443/ws/v5/public"
    : "wss://data-stream.binance.vision:9443/stream?streams=btcusdt@aggTrade/btcusdt@depth20@100ms";

  setConn("connecting");
  let opened = false;

  const ws = new WebSocket(url);
  S.ws = ws;

  const failTimer = setTimeout(() => {
    if (!opened) {
      try { ws.close(); } catch {}
    }
  }, 7000);

  ws.onopen = () => {
    opened = true;
    clearTimeout(failTimer);
    reconnectDelay = 1000;
    S.wsAlive = true;
    if (useOkx) {
      ws.send(
        JSON.stringify({
          op: "subscribe",
          args: [
            { channel: "trades", instId: "BTC-USDT" },
            { channel: "books5", instId: "BTC-USDT" },
          ],
        })
      );
      S.okxPing = setInterval(() => {
        if (ws.readyState === 1) {
          try { ws.send("ping"); } catch {}
        }
      }, 20000);
    }
    setConn("live");
    if (sourceIndex !== 0) {
      showAlert(`当前使用备用数据源：${useOkx ? "OKX" : "Binance 镜像"}（主源恢复后自动切回）`);
    } else {
      showAlert(null);
    }
  };

  ws.onmessage = (ev) => {
    S.lastMsgAt = Date.now();
    if (ev.data === "pong" || ev.data === "ping") return;
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (useOkx) handleOkx(msg);
    else handleBinance(msg);
  };

  ws.onclose = () => {
    clearTimeout(failTimer);
    if (S.okxPing) {
      clearInterval(S.okxPing);
      S.okxPing = null;
    }
    if (S.ws !== ws) return;
    S.wsAlive = false;
    setConn("reconnect");
    sourceIndex = (sourceIndex + 1) % 2;
    const nextName = sourceIndex === 0 ? "Binance 镜像" : "OKX";
    showAlert(`实时连接中断，切换备用数据源（${nextName}）…`);
    reconnectDelay = Math.min(reconnectDelay * 1.6, 12000);
    setTimeout(wsConnect, reconnectDelay);
  };

  ws.onerror = () => {
    try { ws.close(); } catch {}
  };
}

function setConn(state) {
  const dot = $("conn-dot");
  const txt = $("conn-text");
  dot.className = "dot" + (state === "live" ? " live" : state === "reconnect" ? " err" : "");
  txt.textContent =
    state === "live"
      ? `实时 · ${S.exchange === "okx" ? "OKX" : "Binance"}`
      : state === "reconnect"
        ? "重连中…"
        : "连接中…";
}

// ---- Binance 聚合流 ----

function handleBinance(msg) {
  const d = msg.data;
  if (!d) return;
  if (d.e === "aggTrade") {
    onTrade({ ts: d.T, price: parseFloat(d.p), qty: parseFloat(d.q), sideHint: d.m ? "sell" : "buy" });
  } else if (d.e === "depthUpdate" || (!d.e && d.bids && d.asks)) {
    const bids = (d.bids || []).map((b) => ({ price: parseFloat(b[0]), qty: parseFloat(b[1]) }));
    const asks = (d.asks || []).map((a) => ({ price: parseFloat(a[0]), qty: parseFloat(a[1]) }));
    if (bids.length && asks.length) onOrderBook(bids, asks);
  }
}

// ---- OKX v5 ----

function handleOkx(msg) {
  if (msg.event === "subscribe" || msg.event === "error") return;
  const arg = msg.arg || {};
  if (arg.channel === "trades" && Array.isArray(msg.data)) {
    for (const t of msg.data) {
      onTrade({ ts: parseInt(t.ts, 10), price: parseFloat(t.px), qty: parseFloat(t.sz), sideHint: t.side });
    }
  } else if (arg.channel === "books5" && Array.isArray(msg.data)) {
    for (const b of msg.data) {
      const bids = (b.bids || []).map((x) => ({ price: parseFloat(x[0]), qty: parseFloat(x[1]) }));
      const asks = (b.asks || []).map((x) => ({ price: parseFloat(x[0]), qty: parseFloat(x[1]) }));
      if (bids.length && asks.length) onOrderBook(bids, asks);
    }
  }
}

/* ---------------- REST：/api/summary ---------------- */

async function pollSummary() {
  try {
    const res = await fetch("/api/summary", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const d = await res.json();
    if (d.error) throw new Error(d.error);
    S.summary = d;
    S.summaryAt = Date.now();
    S.degraded = d.stale || !(d.spot?.sources || []).some((s) => s.name === "Binance");
    renderSummary();
  } catch (e) {
    console.warn("summary poll failed:", e.message);
    if (Date.now() - S.summaryAt > 30000) showAlert("市场统计暂不可用，正在重试…", true);
  }
}

function renderSummary() {
  const d = S.summary;
  if (!d) return;
  const s = d.spot || {};
  const p = d.perp || {};
  const h = d.h24;

  // REST 兜底刷新价格（WS 未就绪时）
  if (s.price && (S.spotPrice == null || !S.wsAlive)) {
    S.prevPrice = S.spotPrice;
    S.spotPrice = s.price;
    renderPrice();
  }
  if (s.change24 != null) {
    S.chg24 = s.change24;
    renderChg();
  }

  if (h) {
    $("ts-high").textContent = "$" + fmtUsd(h.high);
    $("ts-low").textContent = "$" + fmtUsd(h.low);
    $("ts-vol").textContent = "$" + fmtCompact(h.quoteVolUsd);
    $("ts-trades").textContent = fmtCompact(h.trades);
  }
  if (p.fundingRate != null) {
    const el = $("ts-fr");
    el.textContent = (p.fundingRate * 100).toFixed(4) + "%";
    el.className = "ts-value " + (p.fundingRate >= 0 ? "up" : "down");
  }
  if (p.openInterestBtc != null) {
    $("ts-oi").textContent = fmtCompact(p.openInterestBtc) + " ₿";
  }
  if (p.markPrice != null) {
    $("ts-mark").textContent = "$" + fmtUsd(p.markPrice);
  }
  if (p.markPrice != null && s.price) {
    const basis = ((p.markPrice - s.price) / s.price) * 100;
    const el = $("ts-basis");
    el.textContent = (basis >= 0 ? "+" : "") + basis.toFixed(3) + "%";
    el.className = "ts-value " + (basis >= 0 ? "up" : "down");
  }

  // 统计面板
  $("st-mid").textContent = s.price ? "$" + fmtUsd(s.price) : "--";
  $("st-mark").textContent = p.markPrice ? "$" + fmtUsd(p.markPrice) : "--";
  if (p.fundingRate != null) {
    const fr = p.fundingRate * 100;
    const el = $("st-fr");
    el.textContent = (fr >= 0 ? "+" : "") + fr.toFixed(4) + "%";
    el.className = "stat-v " + (fr >= 0 ? "up" : "down");
    const annual = fr * 3 * 365;
    const el2 = $("st-fry");
    el2.textContent = (annual >= 0 ? "+" : "") + annual.toFixed(1) + "%";
    el2.className = "stat-v " + (annual >= 0 ? "up" : "down");
  }
  if (p.openInterestBtc != null) {
    $("st-oi").textContent = fmtBtc(p.openInterestBtc) + " ₿";
    $("st-oiusd").textContent = "$" + fmtCompact(p.estOiUsd || 0);
  }

  // 数据源徽章
  const names = new Set((s.sources || []).filter((x) => x.ok).map((x) => x.name));
  const badges = document.querySelectorAll("#src-badges .src-badge");
  const map = { 0: "Binance", 1: "OKX", 2: "Gate" };
  badges.forEach((b, i) => {
    const ok = names.has(map[i]);
    b.querySelector("i").style.background = ok ? "var(--up)" : "var(--down)";
    b.style.opacity = ok ? "1" : "0.45";
  });
  $("src-spot").textContent = "· " + (names.has("Binance") ? "Binance" : names.has("OKX") ? "OKX" : names.has("Gate") ? "Gate" : "--");
  $("src-perp").textContent = p.markPrice ? "· 合约" : "";
  $("src-oi").textContent = p.oiSource ? "· " + p.oiSource : "";
  $("stat-refresh").textContent = (d.stale ? "缓存 " : "更新于 ") + hhmmss(d.ts);
}

/* ---------------- 价格渲染 ---------------- */

function renderPrice() {
  const p = S.spotPrice;
  if (p == null) return;
  const [intPart, decPart] = p.toFixed(2).split(".");
  $("price-int").textContent = Number(intPart).toLocaleString("en-US") + ".";
  $("price-cents").textContent = decPart;

  if (S.prevPrice != null && p !== S.prevPrice) {
    const hero = $("price-hero");
    const up = p > S.prevPrice;
    hero.classList.remove("flash-up", "flash-down");
    void hero.offsetWidth;
    hero.classList.add(up ? "flash-up" : "flash-down");
  }
  S.prevPrice = p;

  // 情绪指针：优先 24h 区间位置，回退盘口买卖压
  let pos = null;
  const h = S.summary?.h24;
  if (h?.high && h?.low && h.high > h.low) {
    pos = (p - h.low) / (h.high - h.low);
  } else {
    pos = orderPressure();
  }
  if (pos != null) $("mood-knob").style.left = (clamp(pos, 0, 1) * 100).toFixed(1) + "%";
}

function renderChg() {
  if (S.chg24 == null) return;
  const el = $("chg-chip");
  el.textContent = (S.chg24 >= 0 ? "+" : "") + S.chg24.toFixed(2) + "% 24h";
  el.className = "chg-chip " + (S.chg24 >= 0 ? "up" : "down");
}

/* ---------------- 订单簿 ---------------- */

let obLastRender = 0;
let obDirty = false;

function onOrderBook(bids, asks) {
  S.bids = bids;
  S.asks = asks;
  const bb = bids[0]?.price;
  const ba = asks[0]?.price;
  if (bb && ba && ba > bb) {
    S.mid = (bb + ba) / 2;
    if (S.spotPrice == null) S.spotPrice = S.mid;
  }
  obDirty = true;
  const now = performance.now();
  if (now - obLastRender >= 120) {
    obLastRender = now;
    renderOrderBook();
  }
}

setInterval(() => {
  if (obDirty && performance.now() - obLastRender >= 120) {
    obLastRender = performance.now();
    obDirty = false;
    renderOrderBook();
  }
}, 60);

function renderOrderBook() {
  const bids = S.bids.slice(0, 11);
  const asks = S.asks.slice(0, 11).reverse(); // 高价卖单在上，贴近中间价的在底部
  if (!bids.length || !asks.length) return;

  $("ob-empty").style.display = "none";

  const maxQty = Math.max(...bids.map((b) => b.qty), ...asks.map((a) => a.qty)) || 1;

  let cum = 0;
  $("ob-asks").innerHTML = asks
    .map((a) => {
      cum += a.qty;
      return obRowHtml("ask", a, cum, maxQty);
    })
    .join("");

  cum = 0;
  $("ob-bids").innerHTML = bids
    .map((b) => {
      cum += b.qty;
      return obRowHtml("bid", b, cum, maxQty);
    })
    .join("");

  const bb = S.bids[0];
  const ba = S.asks[0];
  if (bb && ba && S.mid) {
    const spread = ba.price - bb.price;
    $("ob-spread").textContent = "$" + spread.toFixed(2) + " (" + ((spread / S.mid) * 100).toFixed(3) + "%)";
    const press = orderPressure();
    if (press != null) {
      const el = $("ob-pressure");
      el.textContent = (press * 100).toFixed(0) + "%";
      el.style.color = press > 0.55 ? "var(--up)" : press < 0.45 ? "var(--down)" : "var(--ink-2)";
    }
  }
  renderPrice();
}

function obRowHtml(side, lv, cum, maxQty) {
  const big = lv.qty > maxQty * 0.55 ? " bold" : "";
  const w = (lv.qty / maxQty) * 100;
  return (
    `<div class="ob-row ${side}">` +
    `<div class="ob-bar" style="width:${w.toFixed(1)}%"></div>` +
    `<span class="ob-px">${fmtUsd(lv.price)}</span>` +
    `<span class="ob-qty${big}">${fmtBtc(lv.qty)}</span>` +
    `<span class="ob-total">${fmtBtc(cum)}</span>` +
    `</div>`
  );
}

function orderPressure() {
  if (!S.bids.length || !S.asks.length) return null;
  const bv = S.bids.slice(0, 10).reduce((s, b) => s + b.qty, 0);
  const av = S.asks.slice(0, 10).reduce((s, a) => s + a.qty, 0);
  if (bv + av <= 0) return null;
  return bv / (bv + av);
}

/* ---------------- 成交流 / 强度 / 巨鲸 ---------------- */

let tapePending = false;
let tapeTimer = 0;

function onTrade(t) {
  const usd = t.price * t.qty;
  const side = t.sideHint === "sell" ? "sell" : t.sideHint === "buy" ? "buy" : guessSide(t);

  // 会话统计（任务判定用）
  S.sessionTrades += 1;
  S.sessionUsd += usd;
  if (side === S.streakSide) S.streak += 1;
  else {
    S.streakSide = side;
    S.streak = 1;
  }

  // 买卖强度环形缓冲
  const sec = Math.floor(t.ts / 1000);
  const idx = ((sec % 60) + 60) % 60;
  const slot = S.slots[idx];
  if (slot.sec !== sec) {
    slot.sec = sec;
    slot.buy = 0;
    slot.sell = 0;
  }
  if (side === "buy") slot.buy += usd;
  else slot.sell += usd;

  // 成交流
  S.tapeRows.unshift({ ts: t.ts, side, price: t.price, qty: t.qty, usd });
  if (S.tapeRows.length > 60) S.tapeRows.length = 60;

  // 巨鲸
  if (usd >= WHALE_USD) addWhale({ ts: t.ts, side, price: t.price, qty: t.qty, usd });

  // 价格 & 蜡烛图
  S.spotPrice = t.price;
  updateCandle(t);
  renderPrice();

  // 任务
  questProgress();

  // 节流渲染
  tapePending = true;
  if (!tapeTimer) {
    tapeTimer = setTimeout(() => {
      tapeTimer = 0;
      if (tapePending) {
        tapePending = false;
        renderTape();
        renderIntensity();
      }
    }, 240);
  }
}

function guessSide(t) {
  if (!S.bids.length || !S.asks.length) return Math.random() > 0.5 ? "buy" : "sell";
  const dB = Math.abs(t.price - S.bids[0].price);
  const dA = Math.abs(t.price - S.asks[0].price);
  return dB <= dA ? "buy" : "sell";
}

function renderTape() {
  if (!S.tapeRows.length) return;
  $("tape-empty").style.display = "none";
  $("tape-count").textContent = S.sessionTrades.toLocaleString("en-US") + " 笔";

  const html = S.tapeRows
    .slice(0, 26)
    .map((r) => {
      const cls = r.side === "buy" ? "buy" : "sell";
      let lvl = "";
      if (r.usd >= WHALE_USD) lvl = "XL";
      else if (r.usd >= LARGE_USD) lvl = "L";
      return (
        `<div class="tape-row ${lvl}">` +
        `<span class="tape-time">${hhmmss(r.ts)}</span>` +
        `<span class="tape-side ${cls}">${r.side === "buy" ? "BUY" : "SELL"}</span>` +
        `<span class="tape-px">${fmtUsd(r.price)}</span>` +
        `<span class="tape-amt">$${fmtCompact(r.usd)}</span>` +
        `</div>`
      );
    })
    .join("");
  $("tape-list").innerHTML = html;
}

/* ---------------- 巨鲸警报 ---------------- */

function addWhale(w) {
  S.whaleRows.unshift(w);
  if (S.whaleRows.length > 30) S.whaleRows.length = 30;
  S.whaleCountToday += 1;

  const list = $("whale-list");
  const empty = $("whale-empty");
  if (empty) empty.style.display = "none";

  const el = document.createElement("div");
  el.className = "whale-row " + w.side;
  el.innerHTML =
    `<div class="whale-ico">${w.usd >= 500000 ? "🛰️" : "🐳"}</div>` +
    `<div class="whale-main">` +
    `<div class="whale-title">${w.side === "buy" ? "巨鲸扫货" : "巨鲸抛售"}</div>` +
    `<div class="whale-sub">${fmtBtc(w.qty)} BTC @ $${fmtUsd(w.price)}</div>` +
    `</div>` +
    `<div><div class="whale-amt">$${fmtCompact(w.usd)}</div><div class="whale-time">${hhmmss(w.ts)}</div></div>`;

  const first = list.querySelector(".whale-row");
  if (first) list.insertBefore(el, first);
  else list.appendChild(el);
  const rows = list.querySelectorAll(".whale-row");
  if (rows.length > 12) rows[rows.length - 1].remove();

  $("whale-count").textContent = S.whaleCountToday;

  if (S.soundOn) {
    beep(520, 0.07, "triangle");
    setTimeout(() => beep(780, 0.1, "triangle"), 90);
  }
  const superW = w.usd >= 500000;
  toast(superW ? "超级巨鲸出没！" : "巨鲸出没！", `${w.side === "buy" ? "买入" : "卖出"} ${fmtBtc(w.qty)} BTC · $${fmtCompact(w.usd)}`, true);
  flyCoins(el, "+50");
  addScore(50);
  savePersisted();
}

function flyCoins(anchorEl, txt) {
  const fly = document.createElement("span");
  fly.className = "coin-flyup";
  fly.textContent = txt;
  const rect = anchorEl.getBoundingClientRect();
  fly.style.left = Math.max(8, rect.right - 70) + "px";
  fly.style.top = rect.top + "px";
  fly.style.position = "fixed";
  document.body.appendChild(fly);
  setTimeout(() => fly.remove(), 1150);
}

/* ---------------- 任务 & 积分 ---------------- */

function initQuests() {
  const list = $("quest-list");
  list.innerHTML = QUEST_DEFS.map(
    (q) =>
      `<div class="quest${S.doneQuests[q.id] ? " done" : ""}" id="quest-${q.id}">` +
      `<div class="quest-ico">${q.icon}</div>` +
      `<div class="quest-body"><div class="quest-name">${q.name}</div><div class="quest-desc">${q.desc}</div></div>` +
      `<div class="quest-reward">+${q.reward}</div>` +
      `</div>`
  ).join("");
  $("score").textContent = S.score;
  $("whale-count").textContent = S.whaleCountToday;
}

function questProgress() {
  for (const q of QUEST_DEFS) {
    if (S.doneQuests[q.id]) continue;
    let hit = false;
    switch (q.id) {
      case "first_trade": hit = S.sessionTrades >= 1; break;
      case "trades_100": hit = S.sessionTrades >= 100; break;
      case "trades_1000": hit = S.sessionTrades >= 1000; break;
      case "whale_1": hit = S.whaleCountToday >= 1; break;
      case "whale_5": hit = S.whaleCountToday >= 5; break;
      case "vol_1m": hit = S.sessionUsd >= 1e6; break;
      case "streak_up": hit = S.streak >= 8; break;
      case "whale_500k": hit = S.whaleRows.some((w) => w.usd >= 500000); break;
    }
    if (hit) completeQuest(q);
  }
}

function completeQuest(q) {
  S.doneQuests[q.id] = true;
  addScore(q.reward);
  const el = $("quest-" + q.id);
  if (el) {
    el.classList.add("done", "just-done");
    setTimeout(() => el.classList.remove("just-done"), 700);
    flyCoins(el, "+" + q.reward);
  }
  toast("任务完成 · " + q.name, q.desc + " — +" + q.reward + " 积分");
  beep(880, 0.08);
  setTimeout(() => beep(1180, 0.1), 100);
  savePersisted();
}

function addScore(n) {
  S.score += n;
  $("score").textContent = S.score;
}

/* ---------------- 买卖强度 ---------------- */

function renderIntensity() {
  const cv = $("cv-intensity");
  if (!cv) return;
  const w = cv.clientWidth || 280;
  const h = 64;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(w * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const nowSec = Math.floor(Date.now() / 1000);
  S.renderSec = S.renderSec == null ? nowSec : S.renderSec;
  // 时间推进：把空洞秒槽清零（掉线 / 无成交的秒也算时间流逝）
  let guard = 0;
  while (S.renderSec < nowSec && guard < 120) {
    S.renderSec += 1;
    const i = ((S.renderSec % 60) + 60) % 60;
    if (S.slots[i].sec !== S.renderSec) {
      S.slots[i].sec = S.renderSec;
      S.slots[i].buy = 0;
      S.slots[i].sell = 0;
    }
    guard += 1;
  }

  const maxV = Math.max(...S.slots.map((s) => Math.max(s.buy, s.sell)), 1);
  const bw = w / 60;

  for (let i = 0; i < 60; i++) {
    const slot = S.slots[(nowSec - 59 + i + 2880) % 60];
    if (!slot || slot.sec !== nowSec - 59 + i) continue; // 空槽跳过
    const x = i * bw;
    if (slot.buy > 0) {
      const bh = Math.max(1.5, (slot.buy / maxV) * (h - 6));
      ctx.fillStyle = "rgba(14,167,122,0.8)";
      ctx.fillRect(x + 1, h - bh, bw - 2, bh);
    }
    if (slot.sell > 0) {
      const sh = Math.max(1.5, (slot.sell / maxV) * (h - 6));
      ctx.fillStyle = "rgba(229,72,77,0.8)";
      ctx.fillRect(x + 1, h - sh, bw - 2, sh);
    }
  }

  // 底部基线
  ctx.fillStyle = "rgba(12,20,32,0.06)";
  ctx.fillRect(0, h - 1, w, 1);

  const totalBuy = S.slots.reduce((a, s) => a + s.buy, 0);
  const totalSell = S.slots.reduce((a, s) => a + s.sell, 0);
  $("intensity-buy").textContent = "买 $" + fmtCompact(totalBuy);
  $("intensity-sell").textContent = "卖 $" + fmtCompact(totalSell);
  $("intensity-note").textContent =
    totalBuy + totalSell > 0 ? ((totalBuy / (totalBuy + totalSell)) * 100).toFixed(0) + "% 买" : "--";
}

/* ---------------- Canvas 蜡烛图 ---------------- */

function updateCandle(t) {
  const bucket = Math.floor(t.ts / S.tf) * S.tf;
  const last = S.candles[S.candles.length - 1];
  if (!last || bucket > last.t) {
    // 仅接受与现有数据连续的新蜡烛（避免 WS 切源导致跳变）
    S.candles.push({ t: bucket, o: t.price, h: t.price, l: t.price, c: t.price, v: t.qty });
    if (S.candles.length > 200) S.candles.shift();
  } else if (bucket === last.t) {
    last.h = Math.max(last.h, t.price);
    last.l = Math.min(last.l, t.price);
    last.c = t.price;
    last.v += t.qty;
  }
  drawChart();
}

async function loadKlines() {
  try {
    const res = await fetch("/api/klines?tf=" + S.tfMin, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const d = await res.json();
    if (!Array.isArray(d.rows) || !d.rows.length) throw new Error("empty");
    S.candleSrc = d.source;
    S.candles = d.rows.slice(-160);
    $("chart-note").textContent = "历史 · " + d.source;
    $("chart-empty").style.display = "none";
    $("chart-err").style.display = "none";
    drawChartNow();
  } catch (e) {
    console.warn("klines load failed:", e.message);
    $("chart-err").style.display = "grid";
    // 5 秒后重试一次
    setTimeout(loadKlines, 5000);
  }
}

function setTf(minutes) {
  S.tfMin = minutes;
  S.tf = minutes * 60 * 1000;
  S.candles = [];
  S.candleSrc = null;
  $("chart-empty").style.display = "grid";
  $("chart-empty").classList.remove("hide");
  $("chart-empty").textContent = "加载 " + (minutes >= 60 ? minutes / 60 + "h" : minutes + "m") + " 历史K线…";
  $("chart-note").textContent = "加载中";
  loadKlines();
}

let chartTimer = 0;
function drawChart() {
  if (chartTimer) return;
  chartTimer = setTimeout(() => {
    chartTimer = 0;
    drawChartNow();
  }, 200);
}

function drawChartNow() {
  const cv = $("cv-price");
  const wrap = cv.parentElement;
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const candles = S.candles;
  if (candles.length < 2) return;

  $("chart-empty").classList.add("hide");

  const padR = 64;
  const padT = 12;
  const padB = 22;
  const padL = 8;
  const plotW = w - padR - padL;
  const plotH = h - padT - padB;

  let hi = -Infinity;
  let lo = Infinity;
  let maxV = 0;
  for (const c of candles) {
    hi = Math.max(hi, c.h);
    lo = Math.min(lo, c.l);
    maxV = Math.max(maxV, c.v);
  }
  const range = hi - lo || 1;
  hi += range * 0.06;
  lo -= range * 0.06;

  const y = (p) => padT + ((hi - p) / (hi - lo)) * plotH;
  const x = (i) => padL + (i / (candles.length - 1)) * plotW;
  const cw = Math.max(2.5, Math.min(10, (plotW / candles.length) * 0.55));

  // 网格 + 价格轴
  ctx.font = "10.5px ui-monospace, SF Mono, Menlo, monospace";
  ctx.textBaseline = "middle";
  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const p = lo + ((hi - lo) * i) / steps;
    const yy = y(p);
    ctx.strokeStyle = "rgba(12,20,32,0.05)";
    ctx.beginPath();
    ctx.moveTo(padL, yy);
    ctx.lineTo(padL + plotW, yy);
    ctx.stroke();
    ctx.fillStyle = "#8a93a1";
    ctx.fillText(fmtUsd(p, 0), padL + plotW + 8, yy);
  }

  // 最新价虚线 + 标签
  const lastC = candles[candles.length - 1];
  const yLast = y(lastC.c);
  ctx.setLineDash([3, 4]);
  ctx.strokeStyle = "rgba(247,147,26,0.55)";
  ctx.beginPath();
  ctx.moveTo(padL, yLast);
  ctx.lineTo(padL + plotW, yLast);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#f7931a";
  roundRect(ctx, padL + plotW + 4, clamp(yLast - 9, padT, h - padB - 18), 56, 18, 5);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.fillText(fmtUsd(lastC.c, 1), padL + plotW + 10, clamp(yLast, padT + 9, h - padB - 9));

  // 时间轴
  ctx.fillStyle = "#b6bdc9";
  ctx.textAlign = "center";
  const fmtT = (ts) => new Date(ts).toTimeString().slice(0, 5);
  ctx.fillText(fmtT(candles[0].t), padL + 20, h - 9);
  ctx.fillText(fmtT((candles[0].t + lastC.t) / 2), padL + plotW / 2, h - 9);
  ctx.fillText(fmtT(lastC.t), padL + plotW - 20, h - 9);
  ctx.textAlign = "left";

  // 蜡烛 + 成交量
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const up = c.c >= c.o;
    const cx = x(i);
    ctx.strokeStyle = up ? "#0ea77a" : "#e5484d";
    ctx.fillStyle = up ? "rgba(14,167,122,0.9)" : "rgba(229,72,77,0.9)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, y(c.h));
    ctx.lineTo(cx, y(c.l));
    ctx.stroke();
    const yo = y(c.o);
    const yc = y(c.c);
    const top = Math.min(yo, yc);
    const bh = Math.max(1.5, Math.abs(yc - yo));
    ctx.fillRect(cx - cw / 2, top, cw, bh);
    const vh = (c.v / (maxV || 1)) * 26;
    ctx.fillStyle = up ? "rgba(14,167,122,0.18)" : "rgba(229,72,77,0.18)";
    ctx.fillRect(cx - cw / 2, h - padB - vh, cw, vh);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* ---------------- 时钟 / 看门狗 ---------------- */

setInterval(() => {
  $("chip-clock").textContent = hhmmss(Date.now());
  if (S.lastMsgAt) {
    const lat = Date.now() - S.lastMsgAt;
    $("chip-latency").textContent = lat < 1500 ? "WS " + lat + " ms" : "WS …";
  }
  // 看门狗：WS 静默 > 12s 强制断开重连（onclose 里完成容灾切换）
  if (S.wsAlive && S.lastMsgAt && Date.now() - S.lastMsgAt > 12000) {
    try { S.ws.close(); } catch {}
  }
  // 强度计时间推进（无成交也推进）
  renderIntensity();
}, 1000);

/* ---------------- 交互 ---------------- */

$("btn-sound").addEventListener("click", () => {
  S.soundOn = !S.soundOn;
  $("btn-sound").classList.toggle("on", S.soundOn);
  $("btn-sound").textContent = S.soundOn ? "🔔" : "🔕";
  if (S.soundOn) {
    beep(660, 0.08);
    toast("警报音效已开启", "巨鲸出没时会有提示音");
  } else {
    toast("警报音效已关闭", "页面保持安静");
  }
});

$("tf-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tf-tab");
  if (!btn) return;
  document.querySelectorAll(".tf-tab").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  setTf(parseInt(btn.dataset.tf, 10));
});

let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    drawChartNow();
    renderIntensity();
  }, 150);
});

/* ---------------- 启动 ---------------- */

function boot() {
  loadPersisted();
  initQuests();
  wsConnect();
  pollSummary();
  setInterval(pollSummary, 6000);
  setTf(5); // 默认 5m，内部触发 loadKlines
  renderIntensity();
}

boot();
