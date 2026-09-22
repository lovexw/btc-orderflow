# ₿ BTC Pulse — 实时比特币订单流终端

真实行情 · 实时盘口 · 巨鲸警报 · 游戏化观测。像游戏一样有趣，像终端一样专业。

**线上地址**：部署后填写（Cloudflare Workers 默认域 `https://btc-orderflow.<account>.workers.dev`）

---

## 功能

| 模块 | 说明 | 数据源 |
|------|------|--------|
| 实时成交 / 订单簿 | WebSocket 推送，aggTrade + depth20 快照 | Binance 公共镜像（主）→ OKX（备）自动容灾 |
| 价格图表 | 1m/5m/15m/1h 蜡烛图 + 成交量，历史回补 120 根 | `/api/klines`（Binance → OKX） |
| 市场统计 | 资金费率（8h/年化）、合约持仓量、标记价、价差指数 | Worker 聚合 Binance fapi / OKX / Gate |
| 买卖强度计 | 60 秒滚动买卖金额柱状图 | WS 实时聚合 |
| 巨鲸警报 | ≥$100k 大单实时弹窗 + 音效（可选）+ 积分 | WS 实时成交流 |
| 观测任务 | 8 个成就任务 + 积分，localStorage 持久化，按日重置巨鲸计数 | 前端本地 |
| 数据源状态 | 每个上游源实时健康徽章 | `/api/summary` |

## 架构

```
┌────────────┐   WS aggTrade/depth20    ┌─────────────────────┐
│ Binance 镜像 ├─────────────────────────►│                     │
│ (data-api…) │   失败自动切 OKX WS       │   浏览器前端 (SPA)   │
└────────────┘                           │  public/ 静态资源    │
┌────────────┐   WS trades/books5        │                     │
│    OKX     ├──────────────────────────►│                     │
└────────────┘                           └──────────┬──────────┘
                                                    │ 每 6s 轮询
                                         ┌──────────▼──────────┐
                                         │ Cloudflare Worker    │
                                         │ /api/summary 多源聚合 │
                                         │ /api/klines 历史回补  │
                                         │ （白名单域，SSRF 防护）│
                                         └─────────────────────┘
```

- **稳定性设计**：WS 双源自动切换 + 指数退避重连 + 12s 静默看门狗；REST 三源容灾 + 2 分钟陈旧缓存兜底；全部上游带 4s 超时熔断。
- **安全**：Worker 仅请求代码内白名单交易所域名，不回显、不接受用户输入拼 URL。

## 本地运行

```bash
npm install
npx wrangler dev        # http://localhost:8787
```

> 需要网络能访问交易所公共 API（部分区域需代理；Worker 部署到 Cloudflare 后在边缘网络执行，不受本地网络限制）。

## 部署

```bash
npx wrangler deploy     # 部署到 Cloudflare Workers
```

首次部署后 Cloudflare 会输出 `https://btc-orderflow.<subdomain>.workers.dev`。

GitHub 同步：

```bash
git remote add origin git@github.com:lovexw/btc-orderflow.git
git push -u origin main
```

## 修改指南

| 想改什么 | 改哪里 |
|----------|--------|
| 页面配色 / 字体 / 间距 | `public/styles.css` 顶部 `:root` CSS 变量 |
| 交易对（如改 ETH） | `public/app.js` 中 WS streams / instId + `src/worker.js` 中 symbol 参数 |
| 大单 / 巨鲸阈值 | `public/app.js` 顶部 `WHALE_USD`、`LARGE_USD` |
| 任务成就内容 | `public/app.js` 中 `QUEST_DEFS` |
| 数据源 | `src/worker.js` 的 `UPSTREAMS` 与 `handleSummary` |
| 自定义域名 | `wrangler.toml` 添加 `routes` 配置 |

## 质量说明

- ✅ 桌面三栏 / 平板两栏 / 手机单栏响应式布局
- ✅ 加载态（盘口骨架屏 / 图表加载提示）、错误态（WS 重连横幅 / REST 失败提示 / 图表错误重试）、空态（巨鲸监听中）
- ✅ 交互反馈：价格涨跌闪烁、按钮 hover/active、行 hover、任务弹跳、金币飞入
- ✅ 可选音效（WebAudio 合成，无外部资源）；`prefers-reduced-motion` 无障碍适配
- ✅ 隐私：无 Cookie、无追踪、无后端用户数据；积分仅存本地 localStorage

## 免责声明

数据来自交易所公开行情接口，可能存在延迟或偏差。仅供研究参考，不构成任何投资建议。
