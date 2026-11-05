/**
 * mgo2pc Experience 取得プロキシ（Cloudflare Worker）
 *
 * なぜ必要か:
 *   mgo2pc.com の API は CORS ヘッダを返さないため、ブラウザから直接読めない。
 *   プロフィールページは SPA なので HTML を取っても中身が空（2026-11 に仕様変更）。
 *   → このWorkerがサーバー側で公開JSON API を叩き、Experience を計算して返す。
 *
 * デプロイ:
 *   1. https://dash.cloudflare.com/ → Workers & Pages → Create → Worker
 *   2. このコードを貼って Deploy
 *   3. 発行された https://xxx.workers.dev をツールの「取得プロキシURL」に貼る
 *   ※ PhantomJSCloud のキーは不要になりました
 *
 * 使い方: https://xxx.workers.dev/?url=https%3A%2F%2Fmgo2pc.com%2Fprofile%2FSeiren
 * 返り値: { "name": "Seiren", "xp": 2677, "gp": 2331, "exp": 17.76 }
 */
const XP_TABLE = [0, 125, 250, 375, 500, 650, 800, 950, 1100, 1250, 1400, 1550,
  1700, 1850, 2000, 2175, 2350, 2525, 2725, 2975, 3275, 3625, 4075];

function expFromXp(xp) {
  if (xp === null || xp === undefined || xp === '') return null;
  xp = Number(xp);
  if (!isFinite(xp) || xp < 0) return null;
  let lv = 0;
  while (lv + 1 < XP_TABLE.length && xp >= XP_TABLE[lv + 1]) lv++;
  const min = XP_TABLE[lv];
  const next = XP_TABLE[lv + 1];
  const pr = next === undefined ? 1 : Math.max(0, Math.min(1, (xp - min) / (next - min)));
  return lv + pr;
}

export default {
  async fetch(request) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    const json = (o, s = 200) =>
      new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const target = new URL(request.url).searchParams.get('url');
    if (!target) return json({ error: 'url param required (https://mgo2pc.com/profile/NAME)' }, 400);

    const m = String(target).match(/mgo2pc\.com\/profile\/(.+?)\/?$/);
    if (!m) return json({ error: 'only mgo2pc.com/profile/ is allowed' }, 400);

    let name;
    try { name = decodeURIComponent(m[1]); } catch (e) { name = m[1]; }

    const r = await fetch('https://mgo2pc.com/api/v2/profiles/' + encodeURIComponent(name), {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; mgo2pc-proxy/2.0)' },
    });
    if (!r.ok) return json({ error: 'upstream ' + r.status, name }, 502);

    let j;
    try { j = await r.json(); } catch (e) { return json({ error: 'bad json' }, 502); }

    return new Response(JSON.stringify({
      name: j.name || name, xp: j.xp, gp: j.gp, exp: expFromXp(j.xp),
    }), {
      headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=120' },
    });
  },
};
