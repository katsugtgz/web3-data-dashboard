# Harvest summary

Original URL: https://import-command-query-8ca052.surf.computer/ (from index.html `<link rel=icon>` / `og:*`)

## Per-section capture (section-*.json)
Columns: text chars captured / `<tr>` rows found / status. Chinese tab names kept in filenames.

| Section | text chars | tr rows | status |
|---|---|---|---|
| 币圈市场 | 879 | 0 | EMPTY: panel shows "暂无数据" |
| 股票市场 | 3747 | 29 | ok |
| DOGE 监控 | 2821 | 13 | ok |
| 交易赛 | 37561 | 0 | text only, no table |
| 预测市场 | 1070 | 0 | text only |
| 行情解析 | 2856 | 0 | text only |
| X 流量赛道 | 1604 | 0 | text only |
| DeFi 协议榜 | 829 | 0 | EMPTY |
| 流动性池子 | 27151 | 0 | text only |
| 板块异动 | 629 | 0 | text only |
| 链上美股 | 941 | 0 | text only |
| Web3 理财 | 123066 | 0 | text only (largest) |
| VC 投资方 | 954 | 1 | EMPTY |
| 钱包用户 | 1168 | 0 | text only |
| AI 资源 | 6486 | 0 | text only |
| 工具箱 | 9265 | 0 | text only |
| GitHub 库 | 8479 | 0 | text only |

Sections 1-17 = 17 tabs; 项目空投 (airdrop) is the default tab and is listed separately below.

## Failures
- **项目空投 / airdrop Do-it links (target ~80): 0 captured.** airdrop-doit.json = 0. Earlier probe on fresh load found 80 "Do it" elements; after tab clicks, reload, and fresh goto the page renders at 862px with no Do-it nodes. Cause not confirmed.
- **TGE carousel (#tge-track): 0 items.** tge-carousel.json = 0. Track element absent after reload.
- **De1 (#11) and HelloTrade (#12) icon src: not found.** icons-de1-hellotrade.json has found:false for both.
- **Row counts not structured:** most sections are not `<table>`; text dumps saved, not parsed rows. Column headers not extracted.
- **Scroll-to-stable:** harvest scrolled per tab until text length stopped growing; lazy-load rows not confirmed for non-table sections.

## Interactive behaviour observed
- Section tabs: 18 buttons in top strip. Click via mouse works for tab selection but tab panels often render empty (币圈市场, DeFi 协议榜, VC 投资方).
- 币圈市场 subtabs: 妖动榜 (综合分), 跌幅榜, 市值榜, 交易所新币, 铭文, NFT. Board filter chips appear.
- Airdrop tab chips: status / type / chain filters (全部, 交易类, 代币空投, 积分制, 白名单, NFT, 测试网, 主网交互, 社交任务, 质押锁仓, DePIN, 美股代币, 博彩); chain chips (Solana, Base, Ethereum, Arbitrum, BNB, Sui, Monad, HyperEVM, Bera, Aptos, Starknet).
- Ticker bar shows `—` placeholders when live data absent.

## Not verified
- Fresh `goto` after reload: output not captured, so the 80 Do-it state is unconfirmed on current load.
- Live data for 币圈市场 panel: rendered "暂无数据" in screenshot.
