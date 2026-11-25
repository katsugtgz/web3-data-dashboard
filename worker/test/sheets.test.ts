import { describe, expect, test } from 'bun:test';
import { FORBIDDEN_CJK_RE } from './helpers';
import { parseArndxtSheet, parseAsso7878Sheet, parseCsv } from '../src/sources/sheets';

function makeAssoRow(overrides: Record<number, string> = {}): string {
  const cols = Array.from({ length: 28 }, () => '');
  for (const [idx, val] of Object.entries(overrides)) {
    cols[Number(idx)] = val;
  }
  return cols
    .map(c => (/[",\n\r]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c))
    .join(',');
}

describe('RFC 4180 CSV parser', () => {
  test('handles BOM, CRLF, quoted commas, escaped quotes, and multiline fields', () => {
    const raw = '\uFEFF"a,b","c""d","line1\nline2"\r\n1,2,3\r\n';
    expect(parseCsv(raw)).toEqual([
      ['a,b', 'c"d', 'line1\nline2'],
      ['1', '2', '3'],
    ]);
  });

  test('preserves EOF unterminated quoted fields and ignores whitespace between closing quote and delimiter', () => {
    expect(parseCsv('a,"unterminated')).toEqual([['a', 'unterminated']]);
    expect(parseCsv('"foo" ,bar\t\r\n"baz"  ,"qux" ')).toEqual([
      ['foo', 'bar\t'],
      ['baz', 'qux'],
    ]);
  });
});

describe('ASSO7878 Google Sheet parser', () => {
  const sampleCsv = [
    // R0 meta banner
    makeAssoRow({ 2: 'X：ASSO7878 ', 6: '历史更新2026年8月31日 01:50:11 ' }),
    // R1-R5 CEX affiliate promos (must be skipped)
    makeAssoRow({ 0: '交易所', 2: '欧易', 11: 'https://oqmmpieralz.com/join/999' }),
    makeAssoRow({ 0: '', 2: '币安', 11: 'https://bsmkweb.cc/register?ref=123' }),
    // R6 Header
    makeAssoRow({
      0: '分类',
      1: '图',
      2: '项目名称',
      3: '融资$',
      5: '投资机构',
      7: '生态',
      8: '空投潜力',
      9: '收藏日期',
      10: '热度等级',
      11: '关注度',
      12: '详细',
      13: '参与情况',
      14: '交互方式',
      16: '教程',
      17: '奖励对象',
      18: '项目状态',
      19: '是否可多号',
      20: '交互消耗',
      21: '链接',
      22: '邀请码',
      23: '发币TGE',
    }),
    // Standard active row 1 (explicit Col 0, bare domain, whitespace in raise, CJK prose in Col 12/16/22)
    makeAssoRow({
      0: '交易类',
      2: 'Myriad',
      3: '1000 万',
      5: '红杉中国, Paradigm',
      7: '预测',
      8: '明确发币',
      9: '8.28',
      10: '⭐️⭐️⭐️⭐️⭐️',
      11: '5级关注',
      12: '这是一段很长的中文项目详细介绍，绝对不能泄露到输出中',
      13: '重点参与',
      14: '交易',
      16: '点击查看中文教程',
      17: '积分',
      18: '早期',
      19: '可多号',
      20: '无消耗',
      21: 'myriad.markets/?ref=ASSO7878',
      22: '邀请码中文说明 ABC',
      23: '2026Q3',
    }),
    // Standard active row 2 (blank Col 0 carries forward 交易类, CJK project name)
    makeAssoRow({
      0: '',
      2: 'BG钱包',
      3: '未知',
      5: '/',
      7: '钱包',
      8: '新季度',
      9: '3,05',
      10: '⭐️⭐️⭐️',
      11: '3级关注',
      12: '中文简介',
      13: '在参与',
      14: '任务',
      17: '积分币',
      18: '持续',
      19: '精品号',
      20: '少量',
      21: 'https://web3.bitget.com/campaign?invite_code=XYZ&keep=1',
      23: '待定',
    }),
    // Layout B: Ecosystem Multi-Step (Col 21 is 主网 NOT a URL!)
    makeAssoRow({
      0: '主网生态',
      2: 'Monad Eco',
      3: '2.25亿',
      5: 'Paradigm',
      7: 'Layer1',
      8: '潜力大',
      9: '3.2 0',
      10: '⭐️⭐️⭐️⭐️⭐️',
      11: '5级关注',
      12: '中文生态说明',
      13: '在参与',
      14: '1.跨链➨',
      15: '2.每日GM+部署',
      16: '3.交互',
      20: '积分',
      21: '主网',
      22: '可多号',
      23: '少量',
    }),
    // Layout C: Waitlist (URL is in Col 16, Col 21 is empty)
    makeAssoRow({
      0: '候补',
      2: 'Ultrade',
      3: '500万',
      7: 'DeFi',
      8: '潜力中',
      9: '2月',
      10: '⭐️⭐️⭐️',
      11: '2级关注',
      12: '候补中文说明',
      13: '观望等待',
      14: '候补',
      16: 'https://ultrade.org/waitlist?ref=999',
      17: '白名单',
      18: '待开',
      19: '单独号',
      20: '无消耗',
      21: '',
    }),
    // Post-TGE banner + rows (URL is in Col 17; must route to tge[] NOT cards[])
    makeAssoRow({ 0: '下面这些项目已经发币（The project that has been TGE）' }),
    makeAssoRow({
      0: '交易类',
      2: 'HyperLaunch',
      3: '2000万',
      7: '永续',
      8: '已发币',
      9: '1月',
      10: '⭐️⭐️⭐️⭐️',
      13: '已经发币',
      17: 'https://hyperlaunch.xyz/claim?ref=abc',
      18: '持续',
    }),
    // Bankrupt banner + rows (must be SKIPPED)
    makeAssoRow({ 0: '下面这些项目是跑路的（A project that has gone bankrupt）' }),
    makeAssoRow({
      0: '交易类',
      2: 'RugProtocol',
      3: '100万',
      5: '20万',
      13: '项目跑路',
      21: 'https://rugprotocol.xyz',
    }),
    // Abandoned banner + rows (must be SKIPPED even if Col 18 = 持续)
    makeAssoRow({ 0: '以下项目已经放弃（Abandoned projects）' }),
    makeAssoRow({
      0: '放弃项目',
      2: 'AbandonedProto',
      3: '300万',
      18: '持续',
      21: 'https://abandoned.xyz',
    }),
  ].join('\n');

  test('parses 4 layouts, skips CEX/bankrupt/abandoned, strips refs, routes Post-TGE to tge[], and emits zero CJK', () => {
    const now = Date.parse('2026-11-24T00:00:00Z');
    const feed = parseAsso7878Sheet(sampleCsv, now);

    // Zero CJK across entire serialized output
    const serialized = JSON.stringify(feed);
    expect(FORBIDDEN_CJK_RE.test(serialized)).toBe(false);

    // Active cards: Myriad, Bitget Wallet, Monad Eco, Ultrade (4 active; no CEX, no Post-TGE, no Bankrupt, no Abandoned)
    const cardNames = feed.cards.map(c => c.n);
    expect(cardNames).toContain('Myriad');
    expect(cardNames).toContain('Bitget Wallet');
    expect(cardNames).toContain('Monad Eco');
    expect(cardNames).toContain('Ultrade');
    expect(cardNames).not.toContain('HyperLaunch');
    expect(cardNames).not.toContain('RugProtocol');
    expect(cardNames).not.toContain('AbandonedProto');
    expect(cardNames.length).toBe(4);

    // Standard row checks
    const myriad = feed.cards.find(c => c.n === 'Myriad')!;
    expect(myriad.source).toBe('ASSO7878');
    expect(myriad.raiseNum).toBe(10_000_000);
    expect(myriad.url).toBe('https://myriad.markets/');
    expect(myriad.b).toContain('live');
    expect(myriad.b).toContain('early');
    expect(myriad.b).toContain('zero');
    expect(myriad.fit).toContain('zero');
    expect(myriad.fit).toContain('multi');

    // Ref param stripped while keeping functional query param
    const bg = feed.cards.find(c => c.n === 'Bitget Wallet')!;
    expect(bg.url).toBe('https://web3.bitget.com/campaign?keep=1');
    expect(bg.b).toContain('rerun');

    // Ecosystem layout: Col 21 ("主网") rejected as URL; multi-step tasks synthesized in English
    const monad = feed.cards.find(c => c.n === 'Monad Eco')!;
    expect(monad.url).toBeNull();
    expect(monad.raiseNum).toBe(225_000_000);
    expect((monad.tasks ?? []).length).toBeGreaterThanOrEqual(2);

    // Waitlist layout: URL pulled from Col 16 and ref stripped
    const ultrade = feed.cards.find(c => c.n === 'Ultrade')!;
    expect(ultrade.url).toBe('https://ultrade.org/waitlist');

    // Post-TGE routed strictly to tge[] with URL from Col 17
    expect(feed.tge.length).toBe(1);
    expect(feed.tge[0].n).toBe('HyperLaunch');
    expect(feed.tge[0].url).toBe('https://hyperlaunch.xyz/claim');
    expect(feed.tge[0].source).toBe('ASSO7878');
  });

  test('strips extended referral params on sheet URLs while preserving functional query params', () => {
    const header = makeAssoRow({ 0: '分类', 2: '项目名称', 3: '融资$' });
    const rows = [
      header,
      makeAssoRow({ 0: '交易类', 2: 'RefA', 21: 'https://refa.xyz/?referralCode=ABC&id=7' }),
      makeAssoRow({ 0: '', 2: 'RefB', 21: 'https://refb.xyz/?referral_code=XYZ&from=eth&to=arb' }),
      makeAssoRow({ 0: '', 2: 'RefC', 21: 'https://refc.xyz/?join=mycode' }),
      makeAssoRow({ 0: '', 2: 'RefD', 21: 'https://refd.xyz/referral?code=12345' }),
      makeAssoRow({ 0: '', 2: 'RefE', 21: 'https://refe.xyz/share?code=999&keep=1' }),
      makeAssoRow({ 0: '', 2: 'RefF', 21: 'https://reff.xyz/web3/ref?code=ABCD' }),
      makeAssoRow({ 0: '', 2: 'RefG', 21: 'https://refg.xyz/join?r=abc123' }),
      makeAssoRow({ 0: '', 2: 'RefH', 21: 'https://refh.xyz/dashboard?r=xyz789&id=2' }),
      makeAssoRow({ 0: '', 2: 'RefI', 21: 'https://join.conso.tg/shareV2.html?code=NJBXYF' }),
      makeAssoRow({ 0: '', 2: 'RefJ', 21: 'https://app.startale.com/sign-up?code=YVLMPF55' }),
      makeAssoRow({ 0: '', 2: 'RefK', 21: 'https://app.allscale.io/pay/register?code=NDD6OK3' }),
    ].join('\n');

    const feed = parseAsso7878Sheet(rows, Date.parse('2026-11-24T00:00:00Z'));
    const byName = new Map(feed.cards.map(c => [c.n, c.url]));
    expect(byName.get('RefA')).toBe('https://refa.xyz/?id=7');
    expect(byName.get('RefB')).toBe('https://refb.xyz/?from=eth&to=arb');
    expect(byName.get('RefC')).toBe('https://refc.xyz/');
    expect(byName.get('RefD')).toBe('https://refd.xyz/referral');
    expect(byName.get('RefE')).toBe('https://refe.xyz/share?keep=1');
    expect(byName.get('RefF')).toBe('https://reff.xyz/web3/ref');
    expect(byName.get('RefG')).toBe('https://refg.xyz/join');
    expect(byName.get('RefH')).toBe('https://refh.xyz/dashboard?id=2');
    expect(byName.get('RefI')).toBe('https://join.conso.tg/shareV2.html');
    expect(byName.get('RefJ')).toBe('https://app.startale.com/sign-up');
    expect(byName.get('RefK')).toBe('https://app.allscale.io/pay/register');
  });
});

describe('arndxt 2026 English Google Sheet parser', () => {
  test('parses live raise descriptors, avoids false risk badges, routes past TGEs to tge[], and emits zero CJK', () => {
    const csv = [
      'Project,X Handle,Website,Total fundraised (USD),Funding evidence (URL),TGE (approx),TGE reasoning (brief),TGE evidence (URL),Airdrop tasks,Airdrop value per participant (est.),Farming risk,Airdrop score (1-5)',
      'Variational,@variational_io,https://variational.io/?ref=arndxt,"~$119M (total, reported)",https://cryptorank.io/v,Q2 2026,Perp DEX points meta,https://example.com/ev,Trade perps & earn points,High,Low,5',
      'Kite Testnet,@kite_xyz,kite.xyz/faucet,"~$4.5M (seed, reported)",,Q3 2026 (token launch expected),Free testnet,,Claim faucet and run testnet swaps,Medium,"Medium-High (XP is farmable)",3',
      'SeedProto,@seed,https://seedproto.xyz,"$6.3M total (reported)",,Q4 2026,Testnet activity,,Bridge and swap,Medium,High,4',
      'Jupiter,@jup,https://jup.ag,"$11M (seed)",,"Jan 31, 2024 (JUP token launch)",Already launched,,Claim,High,Low,4',
      'Kaito,@kaito,https://kaito.ai,$10.8M,,"Feb 20, 2025 (KAITO token launched)",Already launched,,Yaps,High,Low,4',
      'ConcludedProto,@conc,https://conc.fi,$20M,,Q4 2025 (TGE reported concluded) / claims into 2026,Concluded,,Claimed,Low,Low,2',
    ].join('\n');

    const feed = parseArndxtSheet(csv, Date.parse('2026-11-24T00:00:00Z'));
    expect(FORBIDDEN_CJK_RE.test(JSON.stringify(feed))).toBe(false);

    expect(feed.cards.length).toBe(3);
    const v = feed.cards.find(c => c.n === 'Variational')!;
    expect(v.source).toBe('arndxt');
    expect(v.raiseNum).toBe(119_000_000);
    expect(v.url).toBe('https://variational.io/');
    expect(v.g).toBe('S');

    const k = feed.cards.find(c => c.n === 'Kite Testnet')!;
    expect(k.raiseNum).toBe(4_500_000);
    expect(k.url).toBe('https://kite.xyz/faucet');
    // Farming competition risk must NEVER trigger the drainer/scam 'risk' badge
    expect(k.b).not.toContain('risk');
    expect(k.b).toContain('zero');

    const sp = feed.cards.find(c => c.n === 'SeedProto')!;
    expect(sp.raiseNum).toBe(6_300_000);
    expect(sp.b).not.toContain('risk');

    // Past-TGE projects routed cleanly to tge[]
    expect(feed.tge.map(t => t.n)).toEqual(['Jupiter', 'Kaito', 'ConcludedProto']);
    expect(feed.tge.every(t => t.source === 'arndxt')).toBe(true);
  });

  test('ASSO7878 detects Col 1/Col 2 banners, repeated headers, skips ended/dropped/rug rows, uses nowMs year, and extracts multiline URLs', () => {
    const header = makeAssoRow({ 0: '分类', 2: '项目名称', 3: '融资$', 9: '收藏日期', 13: '参与情况', 18: '项目状态', 21: '链接', 23: '发币TGE' });
    const csv = [
      header,
      // Active valid row with multiline URL cell + bookmark date in 2028
      makeAssoRow({
        0: '交易类',
        2: 'ValidActive',
        3: '1000万',
        9: '5.10',
        13: '在参与',
        18: '持续',
        21: 'Portal:\nhttps://validactive.xyz/app?icode=ASSO7878\nnotes here',
      }),
      // Repeated mid-sheet header row (must be skipped)
      makeAssoRow({ 0: '分类', 2: 'ProjectName', 3: '融资$' }),
      // Active row with status = 结束 (must be skipped)
      makeAssoRow({ 0: '交易类', 2: 'EndedActive', 13: '在参与', 18: '结束', 21: 'https://ended.xyz' }),
      // Active row with Col 13 = 放弃 (must be skipped)
      makeAssoRow({ 0: '交易类', 2: 'DroppedActive', 13: '放弃', 18: '持续', 21: 'https://dropped.xyz' }),
      // Active row with Col 23 = 项目方不让提币 / 项目跑路 (must be skipped)
      makeAssoRow({ 0: '交易类', 2: 'WithdrawBlock', 13: '在参与', 18: '持续', 21: 'https://block.xyz', 23: '项目方不让提币' }),
      makeAssoRow({ 0: '交易类', 2: 'Col23Rug', 13: '在参与', 18: '持续', 21: 'https://rug23.xyz', 23: '项目跑路' }),
      // Banner in Col 1 ONLY (Col 0 and Col 2 empty)
      makeAssoRow({ 1: '下面这些项目是跑路的（A project that has gone bankrupt）' }),
      makeAssoRow({ 0: '交易类', 2: 'LeakedAfterCol1Banner', 21: 'https://leak1.xyz' }),
      // Banner in Col 2 (Col 0 empty)
      makeAssoRow({ 2: '下面这些项目已经发币（The project that has been TGE）' }),
      makeAssoRow({ 0: '交易类', 2: 'PostTgeAfterCol2Banner', 17: 'https://tge2.xyz', 18: '结束' }),
      // Abandoned banner in Col 2
      makeAssoRow({ 2: '以下项目已经放弃（Abandoned projects）' }),
      makeAssoRow({ 0: '交易类', 2: 'LeakedAfterCol2Abandon', 21: 'https://leak2.xyz' }),
    ].join('\n');

    const now2028 = Date.parse('2028-06-15T00:00:00Z');
    const feed = parseAsso7878Sheet(csv, now2028);
    expect(FORBIDDEN_CJK_RE.test(JSON.stringify(feed))).toBe(false);
    expect(feed.cards.map(c => c.n)).toEqual(['ValidActive']);
    expect(feed.cards[0].url).toBe('https://validactive.xyz/app');
    expect(feed.cards[0].updatedTs).toBe(Math.floor(Date.UTC(2028, 4, 10) / 1000));
    expect(feed.tge.map(t => t.n)).toEqual(['PostTgeAfterCol2Banner']);
    expect(feed.tge[0].s).toBe('Ended');
  });

  test('strips extended sheet query params, hash params, referral paths, and project /@handle while keeping social /@handle', () => {
    const header = makeAssoRow({ 0: '分类', 2: '项目名称' });
    const csv = [
      header,
      makeAssoRow({ 0: '交易类', 2: 'Q1', 21: 'https://a.xyz/?icode=111&keep=1' }),
      makeAssoRow({ 0: '', 2: 'Q2', 21: 'http://app.tria.so/?accessCode=14RQNPM0M0' }),
      makeAssoRow({ 0: '', 2: 'Q3', 21: 'https://b.xyz/?RefId=99&ref_id=88&inviter=abc&invite=xyz&inviteCode=77' }),
      makeAssoRow({ 0: '', 2: 'Q4', 21: 'https://c.xyz/app?code=ASSO7878&r=abc&tab=trade' }),
      makeAssoRow({ 0: '', 2: 'Q5', 21: 'https://t.me/MyDropBot?startapp=ABC123' }),
      makeAssoRow({ 0: '', 2: 'Q6', 21: 'https://d.xyz/?start=ref_999&startapp=invite_123' }),
      makeAssoRow({ 0: '', 2: 'H1', 21: 'https://hash.xyz/#/register?ref=ASSO&page=2' }),
      makeAssoRow({ 0: '', 2: 'H2', 21: 'https://hash2.xyz/#/?accessCode=XYZ' }),
      makeAssoRow({ 0: '', 2: 'P1', 21: 'https://rewards.pear.trade/r/asso7878' }),
      makeAssoRow({ 0: '', 2: 'P2', 21: 'https://www.renaiss.xyz/ref/foxeswork8184' }),
      makeAssoRow({ 0: '', 2: 'P3', 21: 'https://pro.edgex.exchange/referral/QUANT' }),
      makeAssoRow({ 0: '', 2: 'P4', 21: 'https://foo.xyz/invite/ABC123' }),
      makeAssoRow({ 0: '', 2: 'P5', 21: 'https://web3.okx.com/join/Q88888' }),
      makeAssoRow({ 0: '', 2: 'P6', 21: 'https://web3.bitget.com/share/25v4rY' }),
      makeAssoRow({ 0: '', 2: 'At1', 21: 'https://www.prjx.com/@ASGJAD' }),
      makeAssoRow({ 0: '', 2: 'At2', 21: 'https://o1.exchange/@aaa888' }),
      makeAssoRow({ 0: '', 2: 'KeepMed', 21: 'https://medium.com/@protocol' }),
      makeAssoRow({ 0: '', 2: 'KeepYt', 21: 'https://www.youtube.com/@protocol' }),
    ].join('\n');

    const feed = parseAsso7878Sheet(csv, Date.parse('2026-11-24T00:00:00Z'));
    const byName = new Map(feed.cards.map(c => [c.n, c.url]));
    expect(byName.get('Q1')).toBe('https://a.xyz/?keep=1');
    expect(byName.get('Q2')).toBe('http://app.tria.so/');
    expect(byName.get('Q3')).toBe('https://b.xyz/');
    expect(byName.get('Q4')).toBe('https://c.xyz/app?tab=trade');
    expect(byName.get('Q5')).toBe('https://t.me/MyDropBot');
    expect(byName.get('Q6')).toBe('https://d.xyz/');
    expect(byName.get('H1')).toBe('https://hash.xyz/#/register?page=2');
    expect(byName.get('H2')).toBe('https://hash2.xyz/');
    expect(byName.get('P1')).toBe('https://rewards.pear.trade/');
    expect(byName.get('P2')).toBe('https://www.renaiss.xyz/');
    expect(byName.get('P3')).toBe('https://pro.edgex.exchange/');
    expect(byName.get('P4')).toBe('https://foo.xyz/');
    expect(byName.get('P5')).toBe('https://web3.okx.com/');
    expect(byName.get('P6')).toBe('https://web3.bitget.com/');
    expect(byName.get('At1')).toBe('https://www.prjx.com/');
    expect(byName.get('At2')).toBe('https://o1.exchange/');
    expect(byName.get('KeepMed')).toBe('https://medium.com/@protocol');
    expect(byName.get('KeepYt')).toBe('https://www.youtube.com/@protocol');
  });

  test('arndxt handles year-aware past token launch dates and fallback column indices 8 (tasks) / 11 (score)', () => {
    const csv = [
      // Header omits "task" and "score" keywords so fallback indices 8 and 11 are exercised
      'Project,X Handle,Website,Total fundraised,Funding evidence,TGE,Reasoning,TGE evidence,Actions,Est Value,Risk,Rating',
      'Past2026Proto,@past,https://past2026.xyz,$15M,,Jan 2026 (PAST token launch),Already done,https://ev.xyz,Bridge and swap,High,Low,4',
      'Future2027Proto,@fut,https://fut2027.xyz,$25M,,2027 (FUT token launch),Upcoming,https://ev.xyz,Trade perps & earn points,High,Low,5',
    ].join('\n');

    const feed = parseArndxtSheet(csv, Date.parse('2026-11-24T00:00:00Z'));
    expect(feed.tge.map(t => t.n)).toEqual(['Past2026Proto']);
    expect(feed.cards.map(c => c.n)).toEqual(['Future2027Proto']);
    expect(feed.cards[0].best.n).toBe('Trade perps & earn points');
    expect(feed.cards[0].g).toBe('S');
    expect(feed.cards[0].sc).toBe(92);
  });
});
