/**
 * btc-orderflow — Cloudflare Worker
 *
 * 职责：
 *  1. 托管 public/ 静态站点（经 [assets] binding）
 *  2. /api/summary — 服务端聚合多交易所行情（现货中间价 + 合约资金费率/持仓量）
 *  3. /api/klines  — K 线历史回补（Binance 镜像 → OKX 容灾）
 *  4. SSRF 防护：仅允许代码内白名单交易所域名；路径写死，不接受用户输入拼 URL
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

// 最近一次成功的 summary（上游全挂时兜底返回，标注 stale）
let lastGoodSummary = null;

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === "/api/summary") {
      return handleSummary();
    }

    if (url.pathname === "/api/klines") {
      return handleKlines(url.searchParams.get("tf") || "5m");
    }

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

/** 单个上游抓取：超时 4s，失败返回 null（绝不抛出） */
async function safeFetch(url, ms = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      cf: { cacheTtl: 0, cacheEverything: false },
      headers: { "User-Agent": "btc-orderflow/1.0", Accept: "application/json" },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** SSRF 防护：仅允许白名单交易所域名 */
function isAllowed(url) {
  try {
    return ALLOWED_HOSTS.has(new URL(url).host);
  } catch {
    return false;
  }
}

async function safeFetchGuarded(url) {
  if (!isAllowed(url)) return null;
  return safeFetch(url);
}

// ---------------------------------------------------------------------------
// /api/summary
// ---------------------------------------------------------------------------

async function handleSummary() {
  const [spotB, spotO, spotG, fapiB, oiB, okxTicker, okxOI, okxFR] = await Promise.all([
    safeFetchGuarded(`${UPSTREAMS.binanceSpot}/api/v3/ticker/24hr?symbol=BTCUSDT`),
    safeFetchGuarded(`${UPSTREAMS.okx}/api/v5/market/ticker?instId=BTC-USDT`),
    safeFetchGuarded(`${UPSTREAMS.gate}/api/v4/spot/tickers?currency_pair=BTC_USDT`),
    safeFetchGuarded(`${UPSTREAMS.binanceFapi}/fapi/v1/premiumIndex?symbol=BTCUSDT`),
    safeFetchGuarded(`${UPSTREAMS.binanceFapi}/fapi/v1/openInterest?symbol=BTCUSDT`),
    safeFetchGuarded(`${UPSTREAMS.okx}/api/v5/market/ticker?instId=BTC-USDT-SWAP`),
    safeFetchGuarded(`${UPSTREAMS.okx}/api/v5/public/open-interest?instId=BTC-USDT-SWAP`),
    safeFetchGuarded(`${UPSTREAMS.okx}/api/v5/public/funding-rate?instId=BTC-USDT-SWAP`),
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

  const h24 = spotB
    ? {
        changePct: parseFloat(spotB.priceChangePercent),
        high: parseFloat(spotB.highPrice),
        low: parseFloat(spotB.lowPrice),
        quoteVolUsd: parseFloat(spotB.quoteVolume),
        trades: parseInt(spotB.count, 10),
      }
    : null;

  // 24h 涨跌：Binance 挂了就用 OKX 现货 open24h 兜底
  let change24 = h24?.changePct ?? null;
  if (change24 == null && spotO?.data?.[0]) {
    const t = spotO.data[0];
    const open = parseFloat(t.open24h);
    if (open > 0) change24 = ((parseFloat(t.last) - open) / open) * 100;
  }

  // ---- 合约数据：Binance（主）→ OKX（备） ----
  let markPrice = null, fundingRate = null, nextFundingTs = null;
  let openInterestBtc = null, oiSource = null;

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
    spot: { price: spotPrice, change24, sources: spotSources },
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
// /api/klines — K 线历史回补（Binance 镜像主，OKX 备）
// ---------------------------------------------------------------------------

const TF_MAP_BINANCE = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h" };
const TF_MAP_OKX = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H" };

async function handleKlines(tf) {
  const bTf = TF_MAP_BINANCE[tf];
  const oTf = TF_MAP_OKX[tf];
  if (!bTf) return jsonResponse({ error: "bad_tf" }, 400);

  const [bK, oK] = await Promise.allSettled([
    safeFetchGuarded(`${UPSTREAMS.binanceSpot}/api/v3/klines?symbol=BTCUSDT&interval=${bTf}&limit=120`),
    safeFetchGuarded(`${UPSTREAMS.okx}/api/v5/market/candles?instId=BTC-USDT&bar=${oTf}&limit=120`),
  ]);

  const bVal = bK.status === "fulfilled" ? bK.value : null;
  if (Array.isArray(bVal) && bVal.length) {
    const rows = bVal.map((k) => ({
      t: k[0],
      o: parseFloat(k[1]), h: parseFloat(k[2]), l: parseFloat(k[3]), c: parseFloat(k[4]), v: parseFloat(k[5]),
    }));
    return jsonResponse({ source: "Binance", tf, rows });
  }

  const oVal = oK.status === "fulfilled" ? oK.value : null;
  if (Array.isArray(oVal?.data) && oVal.data.length) {
    const rows = oVal.data
      .slice()
      .reverse() // OKX 返回新→旧，翻转为旧→新
      .map((k) => ({
        t: parseInt(k[0], 10),
        o: parseFloat(k[1]), h: parseFloat(k[2]), l: parseFloat(k[3]), c: parseFloat(k[4]), v: parseFloat(k[5]),
      }));
    return jsonResponse({ source: "OKX", tf, rows });
  }

  return jsonResponse({ error: "klines_unavailable" }, 502);
}
