/**
 * MGO2PC チーム振り分けツール（v3 / 2026-11 プロフィールAPI対応）
 *
 * v3 の変更点:
 *   1. プロフィールページのスクレイピングを廃止（SPA化でHTMLに値が無くなった）
 *   2. 公開JSON API  https://mgo2pc.com/api/v2/profiles/{name}  の xp から Experience を計算
 *   3. PhantomJSCloud の APIキーが不要になった（設定・入力プロンプトを削除）
 *   4. 失敗した理由（HTTPステータス等）を「取得状況」シートに残す
 *   5. 「診断: 1件テスト」を追加（生の応答を確認できる）
 *
 * 使い方:
 *   「MGO2PC」メニュー → 「Experience一括取得」
 */

/* ============================================================
   メニュー
   ============================================================ */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('MGO2PC')
    .addItem('Experience一括取得', 'fetchAllExperience')
    .addItem('チーム振り分け実行', 'executeTeamAllocation')
    .addSeparator()
    .addItem('プレイヤーを追加（URLを貼るだけ）', 'addPlayer')
    .addSeparator()
    .addItem('診断: 1件テスト', 'diagnoseOne')
    .addItem('診断: 全件チェック（値は書かない）', 'diagnoseAll')
    .addSeparator()
    .addItem('定時取得をON（6時間ごと）', 'installDailyTrigger')
    .addItem('毎朝6時に取得する', 'installMorningTrigger')
    .addItem('定時取得をOFF', 'removeTriggers')
    .addToUi();
}

/* ============================================================
   設定
   ============================================================ */
var DB_SHEET = 'プレイヤーDB';
var ALLOC_SHEET = 'チーム振り分け';
var RESULT_SHEET = '結果';
var STATUS_SHEET = '取得状況';
var DIAG_SHEET = '診断';
var TRIGGER_FN = 'scheduledFetch';
var INTERVAL_HOURS = 6;
var MAX_RETRY = 2;
var API_BASE = 'https://mgo2pc.com/api/v2/profiles/';

/** レベルごとの必要XP（mgo2pc 本体の実装と同じテーブル） */
var XP_TABLE_ = [0, 125, 250, 375, 500, 650, 800, 950, 1100, 1250, 1400, 1550,
  1700, 1850, 2000, 2175, 2350, 2525, 2725, 2975, 3275, 3625, 4075];

/* ============================================================
   Experience 計算
   ============================================================ */
/** xp → Experience（レベル + 次レベルまでの進捗率） */
function expFromXp_(xp) {
  if (xp === null || xp === undefined || xp === '') return null;
  xp = Number(xp);
  if (!isFinite(xp) || xp < 0) return null;
  var lv = 0;
  while (lv + 1 < XP_TABLE_.length && xp >= XP_TABLE_[lv + 1]) lv++;
  var min = XP_TABLE_[lv];
  var next = XP_TABLE_[lv + 1];
  var pr = (next === undefined) ? 1 : Math.max(0, Math.min(1, (xp - min) / (next - min)));
  return lv + pr;
}

/** プロフィールURL → プレイヤー名（URLデコード込み） */
function profileName_(url) {
  var m = String(url || '').match(/mgo2pc\.com\/profile\/(.+?)\/?$/);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
}

/**
 * 1人分の生レスポンスを返す。例外は投げず、失敗理由も文字列で返す。
 * @return {{ok:boolean, name:string, xp:number, exp:number, status:number, reason:string, bodyHead:string}}
 */
function fetchRaw_(url) {
  var out = { ok: false, name: '', xp: null, exp: null, status: 0, reason: '', bodyHead: '' };
  var name = profileName_(url);
  if (!name) { out.reason = 'URLの形式が違う（mgo2pc.com/profile/NAME ではない）'; return out; }
  out.name = name;

  // 任意: スクリプトプロパティ PROXY_URL があれば経由（GASからの直接アクセスが塞がれた場合の逃げ道）
  var proxy = PropertiesService.getScriptProperties().getProperty('PROXY_URL');
  var target = proxy
    ? proxy + (proxy.indexOf('?') < 0 ? '?' : '&') + 'url=' + encodeURIComponent(url)
    : API_BASE + encodeURIComponent(name);

  var res;
  try {
    res = UrlFetchApp.fetch(target, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: { Accept: 'application/json' }
    });
  } catch (e) {
    out.reason = 'UrlFetchApp例外: ' + e.message;
    return out;
  }

  out.status = res.getResponseCode();
  var body = res.getContentText() || '';
  out.bodyHead = body.slice(0, 200);

  if (out.status !== 200) {
    out.reason = 'HTTP ' + out.status;
    return out;
  }
  var j;
  try { j = JSON.parse(body); } catch (e) {
    out.reason = 'JSONではない応答（HTMLが返っている可能性）';
    return out;
  }
  if (j && j.exp != null) {            // プロキシ経由の応答
    out.xp = (j.xp != null) ? Number(j.xp) : null;
    out.exp = Number(j.exp);
  } else if (j && j.xp != null) {      // API直の応答
    out.xp = Number(j.xp);
    out.exp = expFromXp_(out.xp);
  } else {
    out.reason = 'xp フィールドが無い（名前の変更・削除の可能性）';
    return out;
  }
  if (out.exp == null || !isFinite(out.exp)) { out.reason = 'Experience計算に失敗'; return out; }
  out.ok = true;
  return out;
}

function fetchExperienceFromProfile(url) {
  var r = fetchRaw_(url);
  return r.ok ? r.exp : null;
}

function fetchWithRetry_(url) {
  var last = null;
  for (var attempt = 1; attempt <= MAX_RETRY; attempt++) {
    var r = fetchRaw_(url);
    if (r.ok) return r;
    last = r;
    if (attempt < MAX_RETRY) Utilities.sleep(1200);
  }
  return last || { ok: false, reason: '不明なエラー' };
}

/* ============================================================
   一括取得
   ============================================================ */
function fetchAllExperience() {
  var summary = runFetch_();
  if (summary.viaTrigger) return summary;

  SpreadsheetApp.getUi().alert(
    'Experience取得完了\n\n' +
    '成功: ' + summary.success + '件\n' +
    '失敗: ' + summary.failed + '件\n' +
    '所要時間: ' + summary.seconds + '秒\n' +
    (summary.failedNames.length ? '\n失敗: ' + summary.failedNames.join(', ') : '') +
    (summary.failed ? '\n\n理由は「' + STATUS_SHEET + '」シートを見てください。' : '')
  );
  return summary;
}

/** トリガーから呼ばれる入口。ダイアログを出さない。 */
function scheduledFetch() {
  var s = runFetch_();
  s.viaTrigger = true;
  if (s.failed > 0) {
    MailApp.sendEmail(
      Session.getEffectiveUser().getEmail(),
      '[MGO2PC] Experience取得で' + s.failed + '件失敗',
      '失敗: ' + s.failedNames.join(', ') + '\n\n' + STATUS_SHEET + ' シートに理由が出ています。'
    );
  }
  return s;
}

function runFetch_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var db = ss.getSheetByName(DB_SHEET);
  if (!db) throw new Error(DB_SHEET + ' シートがありません');

  var lastRow = Math.max(2, db.getLastRow());
  var rows = db.getRange(2, 2, lastRow - 1, 3).getValues(); // B=名前 C=URL D=Experience

  var status = ss.getSheetByName(STATUS_SHEET) || ss.insertSheet(STATUS_SHEET);
  status.clear();
  status.getRange(1, 1, 1, 3).setValues([['Experience一括取得（v3 / API方式）', '実行中...', '']]);
  status.getRange(2, 1, 5, 1).setValues([['成功'], ['失敗'], ['進捗'], ['経過時間'], ['開始時刻']]);
  status.getRange(6, 2).setValue(new Date());
  status.getRange(8, 1, 1, 3).setValues([['失敗した人', '理由', 'HTTP']]);
  SpreadsheetApp.flush();

  var start = new Date();
  var success = 0, failed = 0;
  var failedNames = [];
  var logRow = 9;

  for (var i = 0; i < rows.length; i++) {
    var name = rows[i][0];
    var url = rows[i][1];
    if (!url) continue;

    status.getRange(3, 2).setValue((i + 1) + '/' + rows.length + ' ' + (name || ''));
    status.getRange(4, 2).setValue(Math.floor((new Date() - start) / 1000) + '秒');
    SpreadsheetApp.flush();

    var r = fetchWithRetry_(url);
    if (r && r.ok) {
      db.getRange(i + 2, 4).setValue(r.exp);
      success++;
    } else {
      failed++;
      failedNames.push(name || ('行' + (i + 2)));
      status.getRange(logRow, 1, 1, 3).setValues([[
        (name || ('行' + (i + 2))) + ' / ' + String(url).slice(0, 60),
        (r && r.reason) || '不明',
        (r && r.status) || 0
      ]]);
      logRow++;
    }
    status.getRange(2, 2).setValue(success + '件');
    status.getRange(3, 2).setValue(failed + '件');
    Utilities.sleep(150);
  }

  var seconds = Math.round((new Date() - start) / 1000);
  status.getRange(1, 2).setValue(failed === 0 ? '完了' : '完了（失敗あり）');
  status.getRange(3, 2).setValue('処理完了');
  status.getRange(4, 2).setValue(seconds + '秒');
  status.getRange(7, 1, 1, 2).setValues([['最終完了', new Date()]]);

  return { success: success, failed: failed, failedNames: failedNames, seconds: seconds, viaTrigger: false };
}

/* ============================================================
   プレイヤー追加
   ============================================================ */
/**
 * プロフィールURLを貼るだけで プレイヤーDB の最下行に追加する。
 * 名前はURLから自動で取り、Experience もその場で取得する。
 * すでに同じURLがある行は、Experienceだけ更新する（重複追加しない）。
 */
function addPlayer() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt(
    'プレイヤーを追加',
    'プロフィールURLを貼り付けてください（カンマ or 改行で複数OK）\n例: https://mgo2pc.com/profile/Seiren',
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;

  var urls = String(res.getResponseText()).split(/[,\n]/).map(function (s) { return s.trim(); })
    .filter(function (s) { return s; });
  if (!urls.length) { ui.alert('URLが空です。'); return; }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var db = ss.getSheetByName(DB_SHEET);
  var lastRow = Math.max(1, db.getLastRow());
  var existing = db.getRange(2, 1, Math.max(1, lastRow - 1), 3).getValues(); // A=No B=名前 C=URL

  var added = 0, updated = 0, failed = [];
  urls.forEach(function (url) {
    if (!/mgo2pc\.com\/profile\//.test(url)) { failed.push(url + '（URLの形式が違う）'); return; }
    var name = profileName_(url);
    var r = fetchRaw_(url);
    var exp = r.ok ? r.exp : '';

    // 同じURLが既にあれば更新
    for (var i = 0; i < existing.length; i++) {
      if (String(existing[i][2]).trim() === url) {
        db.getRange(i + 2, 2).setValue(name || existing[i][1]);
        db.getRange(i + 2, 4).setValue(exp);
        updated++;
        return;
      }
    }

    var row = db.getLastRow() + 1;
    var nextNo = 1;
    for (var j = 0; j < existing.length; j++) {
      var n = parseFloat(existing[j][0]);
      if (!isNaN(n) && n >= nextNo) nextNo = n + 1;
    }
    db.getRange(row, 1, 1, 4).setValues([[nextNo, name || '', url, exp]]);
    existing.push([nextNo, name, url, '']);
    added++;
    if (!r.ok) failed.push((name || url) + '（Experience取得失敗: ' + (r.reason || '不明') + '）');
  });

  ui.alert(
    'プレイヤー追加\n\n' +
    '新規追加: ' + added + '人\n' +
    '既存を更新: ' + updated + '人\n' +
    (failed.length ? '\n要確認:\n・' + failed.join('\n・') : '')
  );
}

/* ============================================================
   診断
   ============================================================ */
/** 1件だけ実行して、生の応答を「診断」シートに書き出す */
function diagnoseOne() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var db = ss.getSheetByName(DB_SHEET);
  var url = db.getRange(2, 3).getValue();
  var name = db.getRange(2, 2).getValue();
  if (!url) { SpreadsheetApp.getUi().alert('C2にURLが入っていません。'); return; }

  var r = fetchRaw_(url);
  var sh = ss.getSheetByName(DIAG_SHEET) || ss.insertSheet(DIAG_SHEET);
  sh.clear();
  var rows = [
    ['プレイヤー', name],
    ['URL', url],
    ['抽出した名前', r.name],
    ['結果', r.ok ? '成功' : '失敗'],
    ['理由', r.reason || '-'],
    ['HTTPステータス', r.status],
    ['xp', r.xp === null ? '-' : r.xp],
    ['Experience', r.exp === null ? '-' : r.exp.toFixed(2)],
    ['応答の先頭200文字', r.bodyHead || '-'],
    ['実行時刻', new Date()]
  ];
  sh.getRange(1, 1, rows.length, 2).setValues(rows);
  SpreadsheetApp.getUi().alert(
    (r.ok ? '成功\n\nExperience: ' + r.exp.toFixed(2) : '失敗\n\n理由: ' + r.reason) +
    '\n\n詳細は「' + DIAG_SHEET + '」シートを見てください。'
  );
}

/** 全員分を取得して成否と理由だけ書き出す（D列は書き換えない） */
function diagnoseAll() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var db = ss.getSheetByName(DB_SHEET);
  var lastRow = Math.max(2, db.getLastRow());
  var rows = db.getRange(2, 2, lastRow - 1, 3).getValues();

  var sh = ss.getSheetByName(DIAG_SHEET) || ss.insertSheet(DIAG_SHEET);
  sh.clear();
  sh.getRange(1, 1, 1, 6).setValues([['名前', '抽出名', 'HTTP', '結果', '理由', 'Experience']]);

  var out = [];
  for (var i = 0; i < rows.length; i++) {
    if (!rows[i][1]) continue;
    var r = fetchRaw_(rows[i][1]);
    out.push([
      rows[i][0], r.name, r.status, r.ok ? 'OK' : 'NG', r.reason || '',
      r.ok ? Number(r.exp.toFixed(2)) : ''
    ]);
  }
  if (out.length) sh.getRange(2, 1, out.length, 6).setValues(out);

  var ng = out.filter(function (x) { return x[3] === 'NG'; }).length;
  SpreadsheetApp.getUi().alert(
    '診断完了\n\n対象: ' + out.length + '人\n成功: ' + (out.length - ng) + '人\n失敗: ' + ng + '人\n\n「' + DIAG_SHEET + '」シートを見てください。'
  );
}

/* ============================================================
   チーム振り分け
   ============================================================ */
function executeTeamAllocation() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var alloc = ss.getSheetByName(ALLOC_SHEET);
  var result = ss.getSheetByName(RESULT_SHEET);
  if (!alloc || !result) { SpreadsheetApp.getUi().alert('シートが見つかりません'); return; }

  var data = alloc.getRange(5, 2, 12, 3).getValues(); // B=名前 C=Experience D=固定チーム
  var players = data
    .filter(function (r) { return r[0] && r[1] !== ''; })
    .map(function (r) {
      return {
        name: String(r[0]).trim(),
        experience: parseFloat(r[1]) || 0,
        fixedTeam: String(r[2] || 'なし').trim()
      };
    });

  if (players.length !== 12) {
    SpreadsheetApp.getUi().alert('12名必要です（現在' + players.length + '名）');
    return;
  }

  var best = allocateBest_(players);
  if (!best) {
    SpreadsheetApp.getUi().alert('固定チームの指定が人数と矛盾しています');
    return;
  }

  for (var i = 0; i < 6; i++) {
    result.getRange(5 + i, 2).setValue(best.red[i] ? best.red[i].name : '');
    result.getRange(5 + i, 3).setValue(best.red[i] ? best.red[i].experience.toFixed(2) : '');
    result.getRange(5 + i, 5).setValue(best.blue[i] ? best.blue[i].name : '');
    result.getRange(5 + i, 6).setValue(best.blue[i] ? best.blue[i].experience.toFixed(2) : '');
  }

  SpreadsheetApp.getUi().alert(
    'チーム振り分け完了\n\n' +
    '赤チーム: ' + best.redTotal.toFixed(2) + '\n' +
    '青チーム: ' + best.blueTotal.toFixed(2) + '\n\n' +
    '差: ' + best.diff.toFixed(2) + (best.perfect ? '\n（最小値に到達）' : '')
  );
}

/**
 * 12人を6-6に分け、経験値合計の差が最小になる組み合わせを返す。
 * 固定チーム（赤/青）は必ず尊重する。C(12,6)=924通りなので全探索で厳密解。
 */
function allocateBest_(players) {
  var red = [], blue = [], free = [];
  players.forEach(function (p) {
    var f = p.fixedTeam;
    if (f === '赤チーム' || f === '赤' || f === 'A') red.push(p);
    else if (f === '青チーム' || f === '青' || f === 'B') blue.push(p);
    else free.push(p);
  });

  var needRed = 6 - red.length;
  var needBlue = 6 - blue.length;
  if (needRed < 0 || needBlue < 0) return null;
  if (needRed + needBlue !== free.length) return null;

  var best = null;
  var combos = [];
  (function walk(start, cur) {
    if (cur.length === needRed) { combos.push(cur.slice()); return; }
    for (var i = start; i < free.length; i++) {
      cur.push(i);
      walk(i + 1, cur);
      cur.pop();
    }
  })(0, []);

  combos.forEach(function (c) {
    var r = red.concat(c.map(function (j) { return free[j]; }));
    var b = blue.concat(free.filter(function (_, j) { return c.indexOf(j) < 0; }));
    if (r.length !== 6 || b.length !== 6) return;
    var rt = r.reduce(function (s, p) { return s + p.experience; }, 0);
    var bt = b.reduce(function (s, p) { return s + p.experience; }, 0);
    var diff = Math.abs(rt - bt);
    if (!best || diff < best.diff) {
      best = { red: r, blue: b, redTotal: rt, blueTotal: bt, diff: diff, perfect: diff < 0.005 };
    }
  });

  return best;
}

/* ============================================================
   定時トリガー
   ============================================================ */
function installDailyTrigger() {
  removeTriggers_();
  ScriptApp.newTrigger(TRIGGER_FN).timeBased().everyHours(INTERVAL_HOURS).create();
  SpreadsheetApp.getUi().alert(
    '定時取得をONにしました（' + INTERVAL_HOURS + '時間ごと）\n\n' +
    '・時刻はGoogle側で少しずれます\n' +
    '・失敗したときは登録メールアドレスに通知が届きます\n' +
    '・トリガーは作成した人のアカウントで動きます'
  );
}

/** 毎日 6:00 に1回だけ取得する（Discordの募集が始まる前の時刻） */
function installMorningTrigger() {
  removeTriggers_();
  ScriptApp.newTrigger(TRIGGER_FN)
    .timeBased()
    .atHour(6)
    .everyDays(1)
    .inTimezone('Asia/Tokyo')
    .create();
  SpreadsheetApp.getUi().alert(
    '毎朝6時に取得するよう設定しました（日本時間）\n\n' +
    '・6:00〜7:00のどこかで実行されます（Google側の混雑で数分ずれます）\n' +
    '・失敗時は登録メールアドレスに通知が届きます'
  );
}

function removeTriggers() {
  var n = removeTriggers_();
  SpreadsheetApp.getUi().alert('定時取得をOFFにしました（削除: ' + n + '件）');
}

function removeTriggers_() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === TRIGGER_FN) { ScriptApp.deleteTrigger(t); n++; }
  });
  return n;
}
