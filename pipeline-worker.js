/**
 * MGO2PC 募集→振り分け 自動パイプライン（Cloudflare Worker / 無料）
 *
 * ① Discordで参加表明（✅ 参加 / 🟡 仮予約）
 * ② 1分ごとにリアクションを集計。**人数が変わったら「誰が」増減したかを通知**
 * ③ 定員に達したらExperienceを取得して6v6を自動計算
 * ④ 結果をDiscordに投稿
 *
 * 必須の環境変数:
 *   DISCORD_BOT_TOKEN / CHANNEL_ID / SHEET_ID / SETUP_KEY
 * 任意:
 *   CAP(12) / WEBHOOK_URL / PHANTOM_KEY / TOPIC / SIGNUP_MESSAGE_ID
 * バインディング:
 *   KV（名前は任意。例: MIX_KV）→ 変数名 KV で紐付け。差分検出に使用
 */
const API = 'https://discord.com/api/v10';
const CONF = '✅';
const TENT = '🟡';

export default {
  async fetch(req, env) {
    try {
      return await route(req, env);
    } catch (e) {
      // 1101 を出さず、原因をJSONで返す（デバッグ用）
      return json({
        ok: false,
        error: String((e && e.message) || e),
        hint: 'この内容をそのまま貼ってください',
      }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env).catch(() => {}));
  },
};

async function route(req, env) {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const key = url.searchParams.get('key');

  if (url.pathname === '/debug') {
    return json({
      env: {
        DISCORD_BOT_TOKEN: !!env.DISCORD_BOT_TOKEN,
        CHANNEL_ID: env.CHANNEL_ID || null,
        SHEET_ID: !!env.SHEET_ID,
        SETUP_KEY: !!env.SETUP_KEY,
        CAP: env.CAP || null,
        TOPIC: env.TOPIC || null,
        KV: !!env.KV,
      },
      kv_test: env.KV ? await env.KV.get('__ping').catch(() => 'error') : 'no binding',
      signup_id: await getSignupId(env),
    });
  }

  if (url.pathname === '/setup' || url.pathname === '/reset') {
    if (!env.SETUP_KEY || key !== env.SETUP_KEY) return text('forbidden', 403);

    const old = await getSignupId(env);
    if (url.pathname === '/reset' && old) {
      if (env.KV) await env.KV.delete(stateKey(env, old));
      let gone = false;
      try { await deleteMessage(env, old); gone = true; } catch (e) {}
      if (!gone) { try { await editMessage(env, old, { content: '【締切】終了しました' }); } catch (e) {} }
    }

    // すでに生きている募集メッセージがあれば、作り直さず再利用する（連打しても増えない）
    if (url.pathname === '/setup' && old && url.searchParams.get('force') !== '1') {
      try {
        const cur = await getMessage(env, old);
        if (cur && !(cur.content || '').startsWith('【締切】')) {
          await ensureReactions(env, old);
          const roster = await readRoster(env, old, parseInt(env.CAP || '12', 10));
          await editMessage(env, old, { content: signupText(roster, parseInt(env.CAP || '12', 10)) });
          return json({ ok: true, reused: true, message_id: old, note: '既存の募集メッセージを再利用しました' });
        }
      } catch (e) {}
    }

    const msg = await createSignup(env);
    if (env.KV) { try { await env.KV.put(msgKey(env), msg.id); } catch (e) {} }
    return json({ ok: true, message_id: msg.id, note: 'KVに保存済み。環境変数の設定は不要です' });
  }

  // Webページ（GitHub Pages）から使うExperience取得プロキシ。
  // CORSが無い mgo2pc API を中継するので、Workerを1つ立てれば足りる。
  if (url.pathname === '/exp') {
    const target = url.searchParams.get('url');
    if (!target) return json({ error: 'urlパラメータが必要です' }, 400);
    const e = await fetchExperience(env, target);
    const name = profileName(target);
    if (e === null) return json({ error: '取得失敗', name }, 502);
    return json({ name, exp: Number(e.toFixed(2)) });
  }

  if (url.pathname === '/preview') {
    const cap = parseInt(env.CAP || '12', 10);
    const id = await getSignupId(env);
    if (!id) return json({ error: '募集メッセージがありません。/setup を実行してください' }, 400);
    const roster = await readRoster(env, id, cap);
    const players = await buildPlayers(env, roster.main.map((u) => u.name));
    const best = allocate(players);
    return json({
      filled: roster.main.length, cap,
      players: players.map((p) => ({ name: p.name, exp: Number(p.exp.toFixed(2)), src: p.src })),
      red: best ? best.red.map((p) => `${p.name} ${p.exp.toFixed(2)}`) : null,
      blue: best ? best.blue.map((p) => `${p.name} ${p.exp.toFixed(2)}`) : null,
      redTotal: best ? Number(best.redTotal.toFixed(2)) : null,
      blueTotal: best ? Number(best.blueTotal.toFixed(2)) : null,
      diff: best ? Number(best.diff.toFixed(2)) : null,
    });
  }
  if (url.pathname === '/status') return json(await status(env));
  return json(await tick(env));
}

/* ---------------- メイン ---------------- */
async function tick(env) {
  const cap = parseInt(env.CAP || '12', 10);
  const msgId = await getSignupId(env);
  if (!msgId) return { skipped: 'SIGNUP_MESSAGE_ID 未設定。/setup を実行してください' };

  const msg = await getMessage(env, msgId);
  if (!msg) return { skipped: 'メッセージが見つかりません' };
  const closed = (msg.content || '').indexOf('【締切】') === 0;

  const roster = await readRoster(env, msgId, cap);
  const prev = await loadState(env, msgId);

  // ---- 変化の通知（誰が増減したか） ----
  const changes = diffRoster(prev || { main: [], wait: [] }, roster, cap);
  if (changes.length) {
    await postLines(env, changes, roster, cap);
  }

  // ---- 募集メッセージの更新（締切後は本文を触らない） ----
  if (!closed && (!prev || prev.sig !== roster.sig)) {
    await editMessage(env, msgId, { content: signupText(roster, cap) });
  }
  await saveState(env, roster, msgId);
  const total = roster.queue.length;          // 仮予約も補欠も「表明した人数」に数える
  const filled = roster.main.length;          // 本枠が埋まった数
  await publishTopic(env, {
    t: 'snap',
    members: roster.conf.map((u) => u.name),
    tent: roster.tent.map((u) => u.name),
    wait: roster.wait.map((u) => u.name),
    count: filled, total, cap, ts: Date.now(),
  });

  if (closed) return { filled, total, wait: roster.wait.length, cap, closed: true, changes };
  if (filled < cap) {
    return { filled, total, wait: roster.wait.length, cap, left: cap - filled, done: false, changes };
  }

  // ---- 本枠が埋まった: 振り分け（本枠の全員で組む） ----
  const players = await buildPlayers(env, roster.main.map((u) => u.name));
  const best = allocate(players);
  if (!best) {
    await postResult(env, {
      title: '振り分けできませんでした', color: 0xE8A63C,
      body: '本枠の人数が6+6にならないか、Experienceを取得できていません。\n`/preview` で中身を確認して、`/reset` でやり直してください。',
    });
    await editMessage(env, msgId, { content: `【締切】${cap}人 確定 — 振り分けに失敗（/preview で確認）` });
    return { filled, done: true, error: 'allocate failed' };
  }
  await postResult(env, {
    title: `${cap}人そろいました — 自動振り分け`, color: 0x5A8DF2,
    fields: [
      { name: `🔴 赤 (${best.redTotal.toFixed(2)})`, value: best.red.map((p) => `${p.name} \`${p.exp.toFixed(2)}\``).join('\n') || '-', inline: true },
      { name: `🔵 青 (${best.blueTotal.toFixed(2)})`, value: best.blue.map((p) => `${p.name} \`${p.exp.toFixed(2)}\``).join('\n') || '-', inline: true },
      { name: '経験値差', value: `**${best.diff.toFixed(2)}**`, inline: false },
    ],
  });
  const missing = players.filter((p) => p.unregistered);
  if (missing.length) {
    await dapi(env, `/channels/${env.CHANNEL_ID}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content: '⚠️ **プレイヤーDBに未登録**: ' +
          missing.map((p) => '`' + p.name + '`').join(' ') +
          `\nExperience 0 で計算しています。シートに追加すると次回から正しくなります。`,
        allowed_mentions: { parse: [] },
      }),
    });
  }
  await editMessage(env, msgId, { content: `【締切】${cap}人 確定 — 振り分けを投稿しました` });
  await publishTopic(env, { t: 'alloc', red: best.red, blue: best.blue, diff: best.diff, ts: Date.now() });
  return { filled, wait: roster.wait.length, done: true, diff: best.diff };
}

/* ---------------- 差分 ---------------- */
function diffRoster(prev, now, cap) {
  const lines = [];
  if (!prev.main && !prev.wait && (prev.conf || prev.tent)) {
    prev = {
      main: (prev.conf || []).map((n) => ({ name: n, tent: false }))
        .concat((prev.tent || []).map((n) => ({ name: n, tent: true }))),
      wait: [],
    };
  }
  const nameOf = (x) => (typeof x === 'string' ? x : x.name);
  const prevMain = new Set((prev.main || []).map(nameOf));
  const prevWait = new Set((prev.wait || []).map(nameOf));
  const nowMain = new Set(now.main.map((u) => u.name));
  const nowWait = new Set(now.wait.map((u) => u.name));

  // 新規
  now.main.forEach((u) => {
    if (!prevMain.has(u.name) && !prevWait.has(u.name)) {
      lines.push(`${u.tent ? '🟡' : '✅'} **${u.name}** が${u.tent ? '仮予約' : '参加'}`);
    }
  });
  now.wait.forEach((u) => {
    if (!prevMain.has(u.name) && !prevWait.has(u.name)) {
      lines.push(`⏳ **${u.name}** が補欠 ${u.wl}番`);
    }
  });
  // 抜けた / 種別変更
  prevMain.forEach((n) => {
    if (!nowMain.has(n)) {
      if (nowWait.has(n)) lines.push(`⏳ **${n}** が補欠に回りました`);
      else lines.push(`↩️ **${n}** がキャンセル`);
    }
  });
  prevWait.forEach((n) => {
    if (!nowWait.has(n)) {
      if (nowMain.has(n)) lines.push(`⬆️ **${n}** が補欠から繰り上がり`);
      else lines.push(`➖ **${n}** が補欠を取り消し`);
    }
  });
  return lines;
}

function signupText(r, cap) {
  cap = cap || 12;
  const main = r.main || [];
  const queue = r.queue || [];
  const conf = r.conf || [];
  const tent = r.tent || [];
  const wait = r.wait || [];
  const filled = main.length;
  const left = Math.max(0, cap - filled);
  const out = [
    '**今日のMIX募集**',
    `✅ 参加 / 🟡 仮予約 — **どちらも枠を使います**`,
    `${cap}人を超えた分は**自動で補欠**（空きが出たら繰り上がり）`,
    '',
    `**${filled} / ${cap}**　${left ? `あと **${left}人**` : '**満員**'}`,
  ];
  if (conf.length) out.push('✅ 参加: ' + conf.map((u) => '`' + u.name + '`').join(' '));
  if (tent.length) out.push('🟡 仮予約: ' + tent.map((u) => '`' + u.name + '`').join(' '));
  if (wait.length) out.push('⏳ 補欠: ' + wait.map((u) => `\`${u.wl}. ${u.name}\``).join(' '));
  if (!queue.length) out.push('_まだ誰もいません_');
  return out.join('\n').slice(0, 2000);
}

async function postLines(env, lines, roster, cap) {
  const filled = roster.main.length;
  const left = Math.max(0, cap - filled);
  const footer = `${filled}/${cap}` + (left ? ` ・ あと${left}人` : ' ・ 満員') +
    (roster.tent.length ? `（仮${roster.tent.length}）` : '') +
    (roster.wait.length ? ` ・ 補欠${roster.wait.length}` : '');
  const batches = [];
  for (let i = 0; i < lines.length; i += 10) batches.push(lines.slice(i, i + 10));
  for (let i = 0; i < batches.length; i++) {
    const body = batches[i].join('\n') + (i === batches.length - 1 ? '\n' + footer : '');
    await dapi(env, `/channels/${env.CHANNEL_ID}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: body.slice(0, 2000), allowed_mentions: { parse: [] } }),
    });
  }
}

/* ---------------- 状態（KV） ---------------- */
const msgKey = (env) => `mixmsg:${env.CHANNEL_ID}`;
const stateKey = (env, id) => `mixstate:${env.CHANNEL_ID}:${id || env.SIGNUP_MESSAGE_ID}`;
async function getSignupId(env) {
  if (env.KV) { try { const v = await env.KV.get(msgKey(env)); if (v) return v; } catch (e) {} }
  return env.SIGNUP_MESSAGE_ID || null;
}
async function loadState(env, id) {
  if (!env.KV) return null;
  try { return await env.KV.get(stateKey(env, id), 'json'); } catch (e) { return null; }
}
async function saveState(env, r, id) {
  if (!env.KV) return;
  try {
    await env.KV.put(stateKey(env, id), JSON.stringify({
      main: r.main.map((u) => ({ name: u.name, tent: !!u.tent })),
      wait: r.wait.map((u) => ({ name: u.name, wl: u.wl, tent: !!u.tent })),
      sig: r.sig,
    }));
  } catch (e) {}
}

/* ---------------- Discord ---------------- */
async function dapi(env, path, init = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(API + path, {
      ...init,
      headers: { Authorization: 'Bot ' + env.DISCORD_BOT_TOKEN, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
    if (res.status === 429) {
      // レート制限。Discordが指定する秒数だけ待ってやり直す
      let wait = 1000;
      try { const j = await res.json(); wait = Math.ceil((j.retry_after || 1) * 1000); } catch (e) {}
      await new Promise((r) => setTimeout(r, Math.min(wait + 120, 5000)));
      continue;
    }
    if (!res.ok) throw new Error(`Discord ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? null : res.json();
  }
  throw new Error('Discord 429: リトライ上限');
}
const getMessage = (env, id) => dapi(env, `/channels/${env.CHANNEL_ID}/messages/${id}`);
const deleteMessage = (env, id) =>
  dapi(env, `/channels/${env.CHANNEL_ID}/messages/${id}`, { method: 'DELETE' });
const editMessage = (env, id, body) =>
  dapi(env, `/channels/${env.CHANNEL_ID}/messages/${id}`, { method: 'PATCH', body: JSON.stringify(body) });

async function readRoster(env, msgId, cap) {
  cap = cap || parseInt(env.CAP || '12', 10);
  const conf = (await getReactions(env, msgId, CONF)).filter((u) => !u.bot);
  const tentRaw = (await getReactions(env, msgId, TENT)).filter((u) => !u.bot);
  const confIds = new Set(conf.map((u) => u.id));
  const tent = tentRaw.filter((u) => !confIds.has(u.id));
  const mk = (u, t) => ({ id: u.id, name: displayName(u), tent: !!t });

  // 反応した順（APIは登録順で返る）に並べ、✅→🟡 の順で1本の待ち行列にする
  const queue = conf.map((u) => mk(u, false)).concat(tent.map((u) => mk(u, true)));

  // 先頭 cap 人が本枠、残りが補欠（キャンセルが出れば自動で繰り上がる）
  const main = queue.slice(0, cap);
  const wait = queue.slice(cap).map((p, i) => ({ ...p, wl: i + 1 }));

  const sig = queue.map((x) => x.name + (x.tent ? 'T' : 'C')).join('|');
  return {
    queue, main, wait,
    conf: main.filter((p) => !p.tent),
    tent: main.filter((p) => p.tent),
    sig,
  };
}

async function createSignup(env) {
  const cap = parseInt(env.CAP || '12', 10);
  const msg = await dapi(env, `/channels/${env.CHANNEL_ID}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: signupText({ main: [], wait: [], queue: [], conf: [], tent: [] }, cap) }),
  });
  await ensureReactions(env, msg.id);
  return msg;
}

/** ✅🟡 を付ける。すでに付いていれば無視。失敗しても例外にしない。 */
async function ensureReactions(env, msgId) {
  const warn = [];
  for (const e of [CONF, TENT]) {
    try {
      await dapi(env, `/channels/${env.CHANNEL_ID}/messages/${msgId}/reactions/${encodeURIComponent(e)}/@me`, { method: 'PUT' });
      await new Promise((r) => setTimeout(r, 350));   // 連続PUTでレート制限に当たらないよう間隔を空ける
    } catch (err) {
      warn.push(String((err && err.message) || err).slice(0, 120));
    }
  }
  if (warn.length) console.log('reaction warn: ' + warn.join(' / '));
  return warn;
}

async function getReactions(env, msgId, emoji) {
  const out = []; let after = null;
  for (let i = 0; i < 10; i++) {
    const q = new URLSearchParams({ limit: '100' });
    if (after) q.set('after', after);
    let page;
    try {
      page = await dapi(env, `/channels/${env.CHANNEL_ID}/messages/${msgId}/reactions/${encodeURIComponent(emoji)}?${q}`);
    } catch (e) {
      // 404=リアクション0件 / 403=権限不足。どちらも「0人」として扱い、全体は止めない
      console.log('reactions ' + emoji + ': ' + String((e && e.message) || e).slice(0, 120));
      return out;
    }
    if (!Array.isArray(page) || !page.length) break;
    out.push(...page);
    if (page.length < 100) break;
    after = page[page.length - 1].id;
  }
  return out;
}

async function postResult(env, { title, body, color, fields }) {
  const embed = { title: title.slice(0, 256), color, footer: { text: '自動募集／自動振り分け' } };
  if (body) embed.description = body;
  if (fields) embed.fields = fields;
  if (env.WEBHOOK_URL) {
    await fetch(env.WEBHOOK_URL + '?wait=true', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'MIX 自動募集', allowed_mentions: { parse: [] }, embeds: [embed] }),
    });
    return;
  }
  await dapi(env, `/channels/${env.CHANNEL_ID}/messages`, { method: 'POST', body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }) });
}

const displayName = (u) => (u.global_name || u.username || 'player').slice(0, 16);

/* ---------------- シート + Experience ---------------- */
async function buildPlayers(env, discordNames) {
  const rows = parseCSV(await fetchSheet(env));
  const db = [];
  for (const r of rows) {
    const url = String(r[2] || '').trim();
    if (url.indexOf('mgo2pc.com/profile/') < 0) continue;
    const exp = parseFloat(String(r[3] || '').replace(/[^0-9.\-]/g, ''));
    db.push({ name: String(r[1] || '').trim(), url, exp: isNaN(exp) ? null : exp });
  }
  const picked = []; const used = new Set();
  for (const dn of discordNames) {
    const idx = db.findIndex((p, i) => !used.has(i) && (norm(p.name) === norm(dn) || norm(dn).includes(norm(p.name)) || norm(p.name).includes(norm(dn))));
    if (idx >= 0) { used.add(idx); picked.push(db[idx]); }
    else picked.push({ name: dn, url: null, exp: null, unregistered: true });
  }
  // シートのD列が古いままでも正しい値で組みたいので、URLがある人は常に最新をAPIから取る。
  // APIが失敗（改名・削除など）したときだけ、シートの値にフォールバックする。
  // EXP_CACHE_TTL（秒）を入れると取得結果をKVにキャッシュする（既定 3600 秒）。
  const ttl = parseInt(env.EXP_CACHE_TTL || '3600', 10);
  for (const p of picked) {
    if (!p.url) {
      // シート未登録でも、mgo2pc 上に同名キャラがいればそれで計算する（初参加者の救済）
      const guess = await fetchExperienceByName(env, p.name);
      if (guess !== null) { p.exp = guess; p.src = 'name'; p.guessed = true; }
      continue;
    }
    const ck = p.url ? `exp:${p.url}` : null;
    if (env.KV && ttl > 0) {
      try {
        const hit = await env.KV.get(ck);
        if (hit) { p.exp = Number(hit); p.src = 'cache'; continue; }
      } catch (e) {}
    }
    const e = await fetchExperience(env, p.url);
    if (e !== null) {
      p.exp = e; p.src = 'api';
      if (env.KV && ttl > 0) { try { await env.KV.put(ck, String(e), { expirationTtl: ttl }); } catch (err) {} }
    } else if (p.exp !== null) {
      p.src = 'sheet';
    }
  }
  return picked.map((p) => ({
    name: p.name, exp: p.exp === null ? 0 : p.exp, fix: 'なし',
    src: p.src || 'none', unregistered: !!p.unregistered && !p.guessed,
  }));
}

const norm = (s) => String(s || '').toLowerCase().replace(/[\s_\-.]/g, '');

async function fetchSheet(env) {
  const u = `https://docs.google.com/spreadsheets/d/${env.SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('プレイヤーDB')}`;
  const r = await fetch(u);
  if (!r.ok) throw new Error('sheet ' + r.status);
  return r.text();
}

function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

/**
 * 2026-11 以降の mgo2pc はプロフィールページが SPA になり、HTML にレベル/進捗が無い。
 * 代わりに公開JSON API が xp / gp を返すので、xp からレベルと進捗を計算する。
 *   GET https://mgo2pc.com/api/v2/profiles/{name}  → { xp, gp, ... }
 */
const XP_TABLE = [0, 125, 250, 375, 500, 650, 800, 950, 1100, 1250, 1400, 1550,
  1700, 1850, 2000, 2175, 2350, 2525, 2725, 2975, 3275, 3625, 4075];

/** xp → Experience（レベル + 次レベルまでの進捗率） */
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

/** プロフィールURL → プレイヤー名 */
function profileName(url) {
  const m = String(url || '').match(/mgo2pc\.com\/profile\/(.+?)\/?$/);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
}

async function fetchExperience(env, url) {
  const name = profileName(url);
  if (!name) return null;
  const r = await fetch('https://mgo2pc.com/api/v2/profiles/' + encodeURIComponent(name), {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; mix-pipeline/2.0)' },
  });
  if (!r.ok) return null;
  let j = null;
  try { j = await r.json(); } catch (e) { return null; }
  return expFromXp(j && j.xp);
}

/** Discord表示名 → mgo2pc のキャラ名としてAPIを引く（未登録者の救済用） */
async function fetchExperienceByName(env, name) {
  if (!name) return null;
  try {
    const r = await fetch('https://mgo2pc.com/api/v2/profiles/' + encodeURIComponent(name), {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; mix-pipeline/2.0)' },
    });
    if (!r.ok) return null;
    const j = await r.json();
    return expFromXp(j && j.xp);
  } catch (e) { return null; }
}

/* ---------------- 6v6 全探索 ---------------- */
function allocate(players) {
  const red = [], blue = [], free = [];
  players.forEach((p) => {
    const f = String(p.fix || '').toUpperCase();
    if (f.startsWith('A') || f.startsWith('赤')) red.push(p);
    else if (f.startsWith('B') || f.startsWith('青')) blue.push(p);
    else free.push(p);
  });
  const needRed = 6 - red.length;
  if (needRed < 0 || needRed > free.length) return null;
  const combos = [];
  (function walk(start, cur) {
    if (cur.length === needRed) { combos.push(cur.slice()); return; }
    for (let i = start; i < free.length; i++) { cur.push(i); walk(i + 1, cur); cur.pop(); }
  })(0, []);
  if (!combos.length) combos.push([]);
  let best = null;
  for (const c of combos) {
    const r = red.concat(c.map((j) => free[j]));
    const b = blue.concat(free.filter((_, j) => !c.includes(j)));
    if (r.length !== 6 || b.length !== 6) continue;
    const rt = r.reduce((s, p) => s + p.exp, 0), bt = b.reduce((s, p) => s + p.exp, 0);
    const d = Math.abs(rt - bt);
    if (!best || d < best.diff) best = { red: r, blue: b, redTotal: rt, blueTotal: bt, diff: d };
  }
  return best;
}

/* ---------------- ntfy ---------------- */
async function publishTopic(env, payload) {
  const topic = (env.TOPIC || 'mgo2pc-mix') + '-r' + today();
  try { await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, { method: 'POST', body: JSON.stringify(payload) }); } catch (e) {}
}
function today() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

async function status(env) {
  const cap = parseInt(env.CAP || '12', 10);
  const id = await getSignupId(env);
  if (!id) return { filled: 0, total: 0, wait: 0, cap, left: cap, members: [], waitlist: [], kv: !!env.KV ? 'ok' : '未設定（差分通知が無効）', note: '/setup を実行してください' };
  const r = await readRoster(env, id, cap);
  const filled = r.main.length;
  return {
    filled, total: r.queue.length, wait: r.wait.length, cap, left: Math.max(0, cap - filled),
    members: r.conf.map((u) => u.name), tent: r.tent.map((u) => u.name),
    waitlist: r.wait.map((u) => `${u.wl}. ${u.name}`),
    kv: !!env.KV ? 'ok' : '未設定（差分通知が無効）',
  };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (o, s = 200) => new Response(JSON.stringify(o, null, 2), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } });
const text = (s, x = 200) => new Response(s, { status: x, headers: { 'Content-Type': 'text/plain' } });
