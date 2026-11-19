# harvest-net DEMO map

Scope: inventory only. No edits to index.html, data.js, harvest/, or harvest-net/ contents other than this file.

## Method

- Parse: all JSON files parsed with `jq`. 0 parse failures.
- Section files are 2D arrays. Row 0 = header (20 columns). Data rows = `length - 1`.
- Record count for airdrop-doit.json and tge.json = top-level array length.
- Byte size = `wc -c`.
- `SUMMARY.md` does not exist. Only `SUMMARY.json` present; used it for cross-check.

## Header (shared by all 19 section files, row 0)

`section, name, raise, investors, ecosystem, potential, date, stars, heat_score, watch_level, description, status, interaction_steps, reward_type, project_status, multi_account, cost, link, invite_code, tge_quarter`

## Section table

| # | Section (CN / EN) | File | Records | First record (name) | Bytes | Type |
|---|---|---|---|---|---|---|
| 1 | 钱包 / Wallets | section-钱包.json | 8 | Gate钱包 | 2978 | project list |
| 2 | 交易类 / Trading | section-交易类.json | 28 | Cascade | 9601 | project list |
| 3 | 预测市场 / Prediction markets | section-预测市场.json | 12 | PolyMarket | 4113 | project list |
| 4 | AI_机器人 / AI bots | section-AI_机器人.json | 15 | pirsmax | 5349 | project list |
| 5 | 挂机 / Idle farming | section-挂机.json | 12 | Gradient | 4649 | project list |
| 6 | 主网生态 / Mainnet ecosystems | section-主网生态.json | 6 | Base | 2237 | project list |
| 7 | 测试网生态 / Testnet ecosystems | section-测试网生态.json | 14 | Arc | 4836 | project list |
| 8 | 另类测试网 / Alt testnets | section-另类测试网.json | 11 | T-REX | 4091 | project list |
| 9 | 跨链桥 / Bridges | section-跨链桥.json | 3 | Euclid Protocol | 1350 | project list |
| 10 | 嘴撸 / Low-effort social | section-嘴撸.json | 3 | Rally | 1261 | project list |
| 11 | 博彩 / Gambling | section-博彩.json | 2 | Megapot | 919 | project list |
| 12 | 存款 / Deposits | section-存款.json | 10 | Glider | 3539 | project list |
| 13 | 模板项目 / Template projects | section-模板项目.json | 12 | Konnex | 4838 | project list |
| 14 | 高频任务类 / High-frequency tasks | section-高频任务类.json | 24 | Conso | 8882 | project list |
| 15 | 未分类 / Uncategorized | section-未分类.json | 78 | BetHog | 25370 | project list |
| 16 | 候补 / Backup (waitlist) | section-候补.json | 25 | Caspius | 7614 | project list |
| 17 | 下面这些项目已经发币 / TGE launched | section-下面这些项目已经发币_The_project_that_has_been_TGE_.json | 50 | HeyElsa | 17727 | project list |
| 18 | 下面这些项目是跑路的 / Rugged or bankrupt | section-下面这些项目是跑路的_A_project_that_has_gone_bankrupt_.json | 16 | ANT.FUN | 6655 | project list |
| 19 | 放弃项目 / Abandoned | section-放弃项目.json | 86 | Xenea | 29465 | project list |
| - | (sum of section rows) | | 415 | | | matches SUMMARY.json `sheetRows` |

Non-section files:

| File | Records | Fields | Bytes | Type |
|---|---|---|---|---|
| airdrop-doit.json | 373 | title, symbol, status, tier, reward_type, is_launched, task, href, in_prior_harvest_80 | 98894 | project/airdrop list |
| tge.json | 19 | project_id, name, symbol, status, date, source_file | 3343 | TGE list (subset of airdrops) |

Counts cross-check: 373 = SUMMARY `active`; 19 = SUMMARY `tge` and `sheetSections`; 415 = SUMMARY `sheetRows`. Section count is 19, not the ~21 expected. The directory also contains `_capture-log.json` (206.1K) and `raw/` (0000–0010.json, not inspected).

No section is metadata or config. All are project lists in sheet form (one project per row, with status/reward_type/link fields).

## Recommendations for DEMO (recommendation only, not implemented)

1. Use `airdrop-doit.json` (373) as the primary project list. It has `tier`, `status`, `href`, and `task`, and covers all active airdrops.
2. Use `tge.json` (19) for a "TGE / launched" view. Matches the TGE section and the SUMMARY counts.
3. Group sheet sections by `reward_type` or theme instead of 19 separate tabs. Good DEMO groups: 钱包 + 交易类 + 预测市场 + 高频任务类 (active actions); 挂机 + 存款 + 主网/测试网生态 (passive); 下面这些项目已经发币 + 跑路 + 放弃 (outcome buckets).
4. Skip 博彩 (2) and 嘴撸 (3) as standalone tabs. Too small; fold into 未分类 or 高频任务类.
5. Treat 未分类 (78) and 放弃项目 (86) as filters, not headline views. Large and low-signal.
6. Use the shared 20-column header as the schema for the sheet sections. Render `status`, `reward_type`, `cost`, `multi_account`, and `link` as the core DEMO columns.
