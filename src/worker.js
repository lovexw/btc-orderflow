/**
 * btc-orderflow — Cloudflare Worker
 *
 * 职责：
 *  1. 托管 public/ 静态站点（经 [assets] binding）
 *  2. /api/summary — 多源聚合行情（现货三源容灾 + 合约资金费率/持仓量 + 24h 统计兜底链）
 *  3. /api/klines  — K 线历史回补（Binance 镜像 → OKX → Gate 三源容灾）
 *  4. /api/diag    — 上游健康诊断（状态码，无敏感信息）
 *  5. SSRF 防护：仅允许代码内白名单交易所域名；路径写死，不接受用户输入拼 URL
 */

const UPSTREAMS = {
  binanceSpot: "https://data-api.binance.vision",
  binanceFapi: "https://fapi.binance.com",
  okx: "https://www.okx.com",
  gate: "https://api.gateio.ws",
};

const ALLOWED_HOSTS = new Set([
  "data-api.binance.vision",
  "fapi.binance.com",
  "www.okx.com",
  "api.gateio.ws",
]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};

// 最近一次成功 summary（上游全挂时兜底返回，标注 stale）+ 上游诊断
let lastGoodSummary = null;
const lastDiag = {}; // label -> {status, ok, at}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === "/api/summary") return handleSummary();
    if (url.pathname === "/api/klines") return handleKlines(url.searchParams.get("tf") || "5m");
    if (url.pathname === "/api/diag") return jsonResponse({ ts: Date.now(), diag: lastDiag });
    if (url.pathname === "/api/health") {
      return jsonResponse({ ok: true, ts: Date.now(), service: "btc-orderflow" });
    }

    return new Response("Not Found", { status: 404, headers: CORS });
  },
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

/** 带诊断的上游抓取：超时 4s，失败返回 null（绝不抛出） */
async function safeFetch(label, url, ms = 4000) {
  if (!ALLOWED_HOSTS.has(safeHost(url))) {
    lastDiag[label] = { status: 0, ok: false, at: Date.now(), err: "blocked_host" };
    return null;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      cf: { cacheTtl: 0, cacheEverything: false },
      headers: { "User-Agent": "btc-orderflow/1.0", Accept: "application/json" },
    });
    lastDiag[label] = { status: res.status, ok: res.ok, at: Date.now() };
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    lastDiag[label] = { status: 0, ok: false, at: Date.now(), err: e?.name || "error" };
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// /api/summary
// ---------------------------------------------------------------------------

async function handleSummary() {
  const [spotB, spotO, spotG, fapiB, oiB, okxTicker, okxOI, okxFR] = await Promise.all([
    safeFetch("binance_t24", `${UPSTREAMS.binanceSpot}/api/v3/ticker/24hr?symbol=BTCUSDT`),
    safeFetch("okx_spot", `${UPSTREAMS.okx}/api/v5/market/ticker?instId=BTC-USDT`),
    safeFetch("gate_spot", `${UPSTREAMS.gate}/api/v4/spot/tickers?currency_pair=BTC_USDT`),
    safeFetch("binance_prem", `${UPSTREAMS.binanceFapi}/fapi/v1/premiumIndex?symbol=BTCUSDT`),
    safeFetch("binance_oi", `${UPSTREAMS.binanceFapi}/fapi/v1/openInterest?symbol=BTCUSDT`),
    safeFetch("okx_swap", `${UPSTREAMS.okx}/api/v5/market/ticker?instId=BTC-USDT-SWAP`),
    safeFetch("okx_oi", `${UPSTREAMS.okx}/api/v5/public/open-interest?instId=BTC-USDT-SWAP`),
    safeFetch("okx_fr", `${UPSTREAMS.okx}/api/v5/public/funding-rate?instId=BTC-USDT-SWAP`),
  ]);

  const now = Date.now();

  // ---- 现货价：三源容灾 ----
  const spotSources = [];
  let spotPrice = null;

  if (spotB?.lastPrice) {
    spotPrice = parseFloat(spotB.lastPrice);
    spotSources.push({ name: "Binance", price: spotPrice, ok: true });
  }
  if (spotO?.data?.[0]?.last) {
    const p = parseFloat(spotO.data[0].last);
    spotSources.push({ name: "OKX", price: p, ok: true });
    if (spotPrice == null) spotPrice = p;
  }
  if (Array.isArray(spotG) && spotG[0]?.last) {
    const p = parseFloat(spotG[0].last);
    spotSources.push({ name: "Gate", price: p, ok: true });
    if (spotPrice == null) spotPrice = p;
  }
  if (spotPrice == null) {
    if (lastGoodSummary && now - lastGoodSummary.ts < 120000) {
      return jsonResponse({ ...lastGoodSummary, stale: true });
    }
    return jsonResponse({ error: "all_spot_sources_failed", ts: now }, 502);
  }

  // ---- 24h 统计：Binance → OKX → Gate 兜底链 ----
  let h24 = null;

  if (spotB) {
    h24 = {
      changePct: parseFloat(spotB.priceChangePercent),
      high: parseFloat(spotB.highPrice),
      low: parseFloat(spotB.lowPrice),
      quoteVolUsd: parseFloat(spotB.quoteVolume),
      trades: parseInt(spotB.count, 10),
      src: "Binance",
    };
  } else if (spotO?.data?.[0]) {
    const t = spotO.data[0];
    const open = parseFloat(t.open24h);
    h24 = {
      changePct: open > 0 ? ((parseFloat(t.last) - open) / open) * 100 : null,
      high: parseFloat(t.high24h),
      low: parseFloat(t.low24h),
      // 现货: vol24h=基础币量(BTC), volCcy24h=计价币量(USDT)
      quoteVolUsd: parseFloat(t.volCcy24h || t.vol24h),
      trades: null,
      src: "OKX",
    };
  } else if (Array.isArray(spotG) && spotG[0]) {
    const t = spotG[0];
    h24 = {
      changePct: parseFloat(t.change_percentage),
      high: parseFloat(t.high),
      low: parseFloat(t.low),
      quoteVolUsd: parseFloat(t.quote_volume),
      trades: null,
      src: "Gate",
    };
  }

  // ---- 合约数据：Binance（主）→ OKX（备） ----
  let markPrice = null,
    fundingRate = null,
    nextFundingTs = null,
    openInterestBtc = null,
    oiSource = null;

  if (fapiB?.markPrice) markPrice = parseFloat(fapiB.markPrice);
  else if (okxTicker?.data?.[0]) markPrice = parseFloat(okxTicker.data[0].last);

  if (fapiB?.lastFundingRate) {
    fundingRate = parseFloat(fapiB.lastFundingRate);
    nextFundingTs = fapiB.nextFundingTime;
  } else if (okxFR?.data?.[0]) {
    fundingRate = parseFloat(okxFR.data[0].fundingRate);
    nextFundingTs = parseInt(okxFR.data[0].nextFundingTime, 10);
  }

  if (oiB?.openInterest) {
    openInterestBtc = parseFloat(oiB.openInterest);
    oiSource = "Binance";
  } else if (okxOI?.data?.[0]) {
    // OKX SWAP: oi=合约张数, oiCcy=基础币数量(BTC), oiUsd=USD 名义价值
    const row = okxOI.data[0];
    const btc = parseFloat(row.oiCcy);
    const oiUsd = parseFloat(row.oiUsd);
    if (isFinite(btc) && btc > 0) {
      openInterestBtc = btc;
      oiSource = "OKX";
    } else if (isFinite(oiUsd) && oiUsd > 0 && markPrice) {
      openInterestBtc = oiUsd / markPrice;
      oiSource = "OKX";
    }
  }

  const payload = {
    ts: now,
    spot: { price: spotPrice, change24: h24?.changePct ?? null, sources: spotSources },
    h24,
    perp: {
      markPrice,
      fundingRate,
      nextFundingTs,
      openInterestBtc,
      oiSource,
      estOiUsd: openInterestBtc != null && markPrice ? openInterestBtc * markPrice : null,
    },
  };
  lastGoodSummary = payload;
  return jsonResponse(payload);
}

// ---------------------------------------------------------------------------
// /api/klines — 三源容灾：Binance 镜像 → OKX → Gate
// ---------------------------------------------------------------------------

const TF_BINANCE = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h" };
const TF_OKX = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H" };
const TF_GATE = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h" };

function validRows(rows) {
  return Array.isArray(rows) && rows.length > 2;
}

async function handleKlines(tf) {
  const bTf = TF_BINANCE[tf];
  const oTf = TF_OKX[tf];
  const gTf = TF_GATE[tf];
  if (!bTf) return jsonResponse({ error: "bad_tf" }, 400);

  // 1) Binance 镜像
  const bK = await safeFetch("binance_klines", `${UPSTREAMS.binanceSpot}/api/v3/klines?symbol=BTCUSDT&interval=${bTf}&limit=120`);
  if (Array.isArray(bK) && validRows(bK)) {
    return jsonResponse({
      source: "Binance",
      tf,
      rows: bK.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })),
    });
  }

  // 2) OKX（limit 上限 100）
  const oK = await safeFetch("okx_klines", `${UPSTREAMS.okx}/api/v5/market/candles?instId=BTC-USDT&bar=${oTf}&limit=100`);
  if (Array.isArray(oK?.data) && validRows(oK.data)) {
    return jsonResponse({
      source: "OKX",
      tf,
      rows: oK.data
        .slice()
        .reverse() // OKX 返回新→旧
        .map((k) => ({ t: parseInt(k[0], 10), o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })),
    });
  }

  // 3) Gate：[ts(秒), quoteVol, close, high, low, open, baseVol]
  const gK = await safeFetch("gate_klines", `${UPSTREAMS.gate}/api/v4/spot/candlesticks?currency_pair=BTC_USDT&interval=${gTf}&limit=120`);
  if (Array.isArray(gK) && validRows(gK)) {
    return jsonResponse({
      source: "Gate",
      tf,
      rows: gK.map((k) => ({
        t: parseInt(k[0], 10) * 1000,
        o: +k[5], h: +k[3], l: +k[4], c: +k[2], v: +k[6] || 0,
      })),
    });
  }

  return jsonResponse({ error: "klines_unavailable", diag: lastDiag }, 502);
}
