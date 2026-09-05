// GBF Raid Filter - Side Panel Script v1.2.2

const DEFAULTS = {
  hpOn: false, hpMode: 'above', hpVal: 50,
  memOn: false, memMode: 'below', memVal: 5,
  bpOn: false,
  condOpen: false,
  sort: 'default',
  iconBarPos: 'left',
  hostHistoryCols: 3,
  hostCategoryFilters: ['all'],
  hideDepleted: true,
  showEventBanner: true,
  hideJoined: false,
  keepDropLogOnRemove: false,
  lang: 'zh',
};

// ── 新リリース通知（GitHub Releases） ───────────────────
const UPDATE_RELEASE_API = 'https://api.github.com/repos/ermi-chang/Chrome-HamuBle/releases/latest';
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

let allRaids    = [];
// フィルタ経由でクリック参加した raidId の一時ログ。リスト更新（load での再取得）ごとに
// 全クリアする — 更新後は本体側の ico-enter が参加済みを示すため引き継ぎ不要。
const JOINED_LOG_MAX = 10;
const joinedRaidIds = new Set();
let isLoading   = false;
let settings    = { ...DEFAULTS };
let templates   = [];
let activeTplId = null;
const FAV_SLOT_COUNT = 10;
const FAV_NAME_MAX = 20;
const FAV_LONGPRESS_MS = 400;
// favorites[i] = { url, title, customName, addedAt } | null
let favorites   = new Array(FAV_SLOT_COUNT).fill(null);

// ── ドロップログ（累計） ───────────────────────────────
// 取得イベントごとに 1 件として保持する時系列ログ（最新先頭、最大 500 件 / 90 日）。
// 同じアイテムでも別タイミングで取れば別エントリ。表示は月単位カレンダー（7×4〜6 セル）。
// 画像URL正規化は parseAssetUrl / buildIconUrl / buildMatchUrl を参照。
const DROP_EVENTS_MAX    = 500;
const DROP_EVENTS_TTL_MS = 90 * 24 * 60 * 60 * 1000;  // 90 日（約 3 ヶ月）
const DROP_WATCH_MAX     = 20;
let dropEvents     = [];  // [{ watchId, at, count }, ...]  新しいものが先頭
// カレンダー表示中の月（year, month: 0-11）。初期値 = 今月。`<`/`>` で前後月へ移動。
let calendarMonth  = (() => { const n = new Date(); return { year: n.getFullYear(), month: n.getMonth() }; })();
let dropWatch      = [];  // [{ id, name, category, itemId, iconCached, addedAt }]
// ログ保持設定 ON で watch を削除した際のメタ退避先（カレンダー描画で参照）。
// dropEvents に watchId が残っている間だけ保持し、pruneDropWatchArchive() で掃除。
const DROP_WATCH_ARCHIVE_MAX = 40;
let dropWatchArchive = [];  // [{ id, name, category, itemId, iconCached, removedAt }]
let seenResultKeys = {};  // { [resultKey]: detectedAt }  二重カウント防止（古いものは TTL で掃除）
const SEEN_RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 日

// 最近観測ドロップ（フッター用）。蓄積せず最新リザルトのみ session メモリに保持。
// 新リザルトが入るたびに置換、サイドパネルを閉じれば失われる。storage 書き込みなし。
let lastResultDrops = [];  // [{ category, itemId, count }]（表示 URL は描画時に s/.jpg を組み立て）

// 既定ウォッチリスト確定値（Phase C v2）。ヒヒイロカネ + 刻の流砂 のみ。
// iconCached は起動時に DROP_ICON_FETCH で埋める。
const DEFAULT_DROP_WATCH = [
  { id: 'item-evolution-20004', name: 'ヒヒイロカネ', category: 'item/evolution', itemId: '20004', iconCached: '', addedAt: 0 },
  { id: 'item-article-215',     name: '刻の流砂',     category: 'item/article',   itemId: '215',   iconCached: '', addedAt: 0 },
];

// ── GBF 画像 CDN URL 正規化 ──────────────────────────
// 入力 URL: https://prd-game-a-granbluefantasy.akamaized.net/assets/img/sp/assets/{category}/{m|s|b}/{id}.{jpg|png}
// - category は 1 階層 (weapon, summon...) または 2 階層 (item/article, item/evolution...)
// - 表示=s/.jpg、検索=m/.jpg、稀に登録される変換対象=b/.png
// 内部キー = `{category}/{itemId}` の文字列。
const ASSET_HOST = 'https://prd-game-a-granbluefantasy.akamaized.net/assets/img/sp/assets';
function parseAssetUrl(u) {
  if (typeof u !== 'string') return null;
  const m = /\/sp\/assets\/(.+?)\/(m|s|b)\/(\d+)\.(jpg|png)(?:[?#]|$)/i.exec(u);
  if (!m) return null;
  return { category: m[1], size: m[2], itemId: m[3], ext: m[4].toLowerCase() };
}
function dropMatchKey(category, itemId) { return `${category}/${itemId}`; }
function buildIconUrl(category, itemId) { return `${ASSET_HOST}/${category}/s/${itemId}.jpg`; }
function buildMatchUrl(category, itemId) { return `${ASSET_HOST}/${category}/m/${itemId}.jpg`; }
// watchId は category / を - に置換して URL/CSS-safe にしたもの
function makeWatchId(category, itemId) {
  return `${category.replace(/\//g, '-')}-${itemId}`;
}
// アイコン取得依頼中の watchId 集合（重複 fetch 抑制）
const dropIconFetchPending = new Set();

// ── BP 状態 ──────────────────────────────────────────
// currentBP: GBF DOM から取れた現在の BP。null = 未取得（救援タブ非表示時など）
// panelLockUntilBp: ロック中の閾値。currentBP が これ以上 になったら自動解除
let currentBP = null;
let panelLockUntilBp = null;

// ── マイクエスト状態 ────────────────────────────────────
let activeTab       = 'dashboard'; // 'dashboard' | 'rescue' | 'host-history' | 'info'
let prevTab         = 'dashboard'; // info タブ離脱先
let hostHistory     = [];         // [{ questId, questType, treasureId, lastTimestamp, todayCount, raidCategory, eventPeriodEndMs?, eventName? }]
let questMeta       = {};         // { [questId]: { chapterName, limitedCount, maxLimitedCount, ... } }
let hostHistoryDate = '';         // GBF日付文字列
// 開催中／予告イベント。content.js が #event/.. または #teaser/.. を踏むたびに更新。periodEndMs 経過で自動除去。
// （内部の期間/hostHistory連携レジストリ。ユーザー表示は eventBanners 側のバナーへ移行済み）
let activeEvents    = {};         // { [eventName]: { eventName, title, periodText, periodEndMs, hash, lastSeenAt } }
// mypage グローバルバナー由来のイベント表示ストア。path（=data-href, hash から # を除いた値）をキーにする。
let eventBanners    = {};         // { [path]: { path, hash, bannerSrc, srcUrl, isTeaser, periodText, eventStartMs, eventEndMs, lastSeenAt } }
// 画像取得（base64化）依頼中の path 集合（重複 fetch 依頼の抑制・セッション内のみ）
const bannerFetchPending = new Set();
let lastHostDetectKey = '';
let lastHostDetectAt  = 0;
let recentHostDecrementAt = {};   // { [questId]: timestamp }
/** マイクエストタイル→自発遷移直後のみ。SELF_HOST_DETECTED で消費し回数だけ更新する */
let panelHostExpect = null;       // { questId: string, ts: number } | null

function consumePanelHostExpect(questId) {
  const exp = panelHostExpect;
  if (!exp) return false;
  if (Date.now() - exp.ts > 120_000) {
    panelHostExpect = null;
    return false;
  }
  const ok = String(exp.questId) === String(questId);
  panelHostExpect = null;
  return ok;
}

// ── DOM refs ────────────────────────────────────────
const elList         = document.getElementById('list');
const elCount        = document.getElementById('count');
const elUpdated      = document.getElementById('updated');
const elBpDisplay    = document.getElementById('bp-display');
const elBpDisplayValue = document.getElementById('bp-display-value');
const elBpShortageBanner = document.getElementById('bp-shortage-banner');
const btnSettings    = document.getElementById('btn-settings');
const settingsPanel  = document.getElementById('settings-panel');
const btnAssist      = document.getElementById('btn-assist');
const btnAssistUnclaimed = document.getElementById('btn-assist-unclaimed');
const btnHome        = document.getElementById('btn-home');

const elHpOn          = document.getElementById('hp-on');
const elHpModeToggle  = document.getElementById('hp-mode-toggle');
const elHpVal         = document.getElementById('hp-val');
const elHpValDisplay  = document.getElementById('hp-val-display');
const elHpBlock       = document.getElementById('hp-block');
const elMemOn         = document.getElementById('mem-on');
const elMemModeToggle = document.getElementById('mem-mode-toggle');
const elMemVal        = document.getElementById('mem-val');
const elMemValDisplay = document.getElementById('mem-val-display');
const elMemBlock      = document.getElementById('mem-block');
const elBpOn    = document.getElementById('bp-on');
const elBpBlock = document.getElementById('bp-block');
const elSort    = document.getElementById('sort');
const btnCond      = document.getElementById('btn-cond');
const elCondPanel  = document.getElementById('cond-panel');
const elCondSummary = document.getElementById('cond-summary');

const elIconBarPosGroup      = document.getElementById('icon-bar-pos-btns');
const elHostHistoryColsGroup = document.getElementById('host-history-cols-btns');
// 完了クエスト非表示 / 本日上限解除は設定パネルではなくマイクエストヘッダのトグル
const btnHideDepleted     = document.getElementById('btn-hide-depleted');
const btnDepletedOverride = document.getElementById('btn-depleted-override');
const elShowEventBanner = document.getElementById('show-event-banner');
const elHideJoined      = document.getElementById('hide-joined');
const elKeepDropLog     = document.getElementById('keep-drop-log');
const elIconBar   = document.getElementById('icon-bar');
const elDashboard = document.getElementById('dashboard');
// カレンダースクショ生成中フラグ（連打防止。再描画でボタンが差し替わっても効く）
let calShotBusy = false;
// ダッシュボード内のドロップカレンダー左右ナビ（再描画後も生き残るよう委譲）
if (elDashboard) {
  elDashboard.addEventListener('click', (e) => {
    const prev = e.target.closest('.dash-drop-cal-prev');
    if (prev) {
      if (calendarMonth.month === 0) { calendarMonth.year--; calendarMonth.month = 11; }
      else calendarMonth.month--;
      renderDashboard();
      return;
    }
    const shot = e.target.closest('.dash-drop-cal-shot');
    if (shot) {
      if (calShotBusy) return;
      calShotBusy = true;
      shot.disabled = true;
      exportDropCalendarPNG()
        .then(() => flashCalShotButton('✓'), () => flashCalShotButton('✕'));
      return;
    }
    const next = e.target.closest('.dash-drop-cal-next');
    if (next && !next.hasAttribute('disabled')) {
      if (calendarMonth.month === 11) { calendarMonth.year++; calendarMonth.month = 0; }
      else calendarMonth.month++;
      renderDashboard();
    }
  });
}
const elHostDate      = document.getElementById('host-date');
const btnClearHistory = document.getElementById('btn-clear-history');
const elHostCategoryBar = document.getElementById('host-category-bar');

const templateScroll = document.getElementById('template-scroll');
const btnTplAdd      = document.getElementById('btn-tpl-add');
const tplNameRow     = document.getElementById('tpl-name-row');
const tplNameInput   = document.getElementById('tpl-name-input');
const btnTplSave     = document.getElementById('btn-tpl-save');
const btnTplCancel   = document.getElementById('btn-tpl-cancel');

// ── 設定の保存・読み込み ────────────────────────────
function saveAll() {
  chrome.storage.local.set({
    gbfRfSettings:  settings,
    gbfRfTemplates: templates,
  });
}

function saveFavorites() {
  chrome.storage.local.set({ gbfRfFavorites: favorites });
}

async function loadAll() {
  return new Promise(resolve => {
    chrome.storage.local.get(['gbfRfSettings', 'gbfRfTemplates', 'gbfRfFavorites'], data => {
      if (data.gbfRfSettings) {
        settings = { ...DEFAULTS, ...data.gbfRfSettings };
        // 旧: hostCategoryFilter (string) → 新: hostCategoryFilters (array)
        if (typeof data.gbfRfSettings.hostCategoryFilter === 'string'
            && !Array.isArray(data.gbfRfSettings.hostCategoryFilters)) {
          settings.hostCategoryFilters = [data.gbfRfSettings.hostCategoryFilter];
        }
        if (!Array.isArray(settings.hostCategoryFilters) || settings.hostCategoryFilters.length === 0) {
          settings.hostCategoryFilters = ['all'];
        }
      }
      if (data.gbfRfTemplates) templates = data.gbfRfTemplates;
      if (Array.isArray(data.gbfRfFavorites)) favorites = data.gbfRfFavorites;
      // ── マイグレーション: 旧 5 スロット → 新 10 スロット、customName / addedAt 補完 ──
      if (favorites.length < FAV_SLOT_COUNT) {
        while (favorites.length < FAV_SLOT_COUNT) favorites.push(null);
      } else if (favorites.length > FAV_SLOT_COUNT) {
        favorites.length = FAV_SLOT_COUNT;
      }
      let favDirty = false;
      for (let i = 0; i < FAV_SLOT_COUNT; i++) {
        const f = favorites[i];
        if (f && typeof f === 'object') {
          if (typeof f.customName !== 'string') { f.customName = ''; favDirty = true; }
          if (typeof f.addedAt !== 'number')    { f.addedAt = Date.now(); favDirty = true; }
        }
      }
      if (favDirty) chrome.storage.local.set({ gbfRfFavorites: favorites });
      resolve();
    });
  });
}

function applySettingsToUI() {
  elHpOn.checked     = settings.hpOn;
  setModeToggle(elHpModeToggle, settings.hpMode);
  // hp/mem の range 範囲外マイグレーションは先にまとめて行い、
  // saveAll() を 1 回だけにすることで中間状態が storage に書き込まれないようにする。
  const clampedHp  = Math.min(100, Math.max(20, (parseFloat(settings.hpVal) || 50)));
  const clampedMem = Math.min(6,   Math.max(1,  (parseInt(settings.memVal, 10) || 5)));
  let migrated = false;
  if (clampedHp  !== settings.hpVal)  { settings.hpVal  = clampedHp;  migrated = true; }
  if (clampedMem !== settings.memVal) { settings.memVal = clampedMem; migrated = true; }
  if (migrated) saveAll();
  elHpVal.value      = clampedHp;
  elHpValDisplay.textContent = clampedHp;
  elMemOn.checked    = settings.memOn;
  setModeToggle(elMemModeToggle, settings.memMode);
  elMemVal.value     = clampedMem;
  elMemValDisplay.textContent = clampedMem;
  elBpOn.checked     = settings.bpOn;
  elSort.value       = settings.sort;
  setPillValue('icon-bar-pos-btns',      settings.iconBarPos || 'left');
  setPillValue('host-history-cols-btns', String(settings.hostHistoryCols || 3));
  btnHideDepleted.classList.toggle('active', !!settings.hideDepleted);
  elShowEventBanner.checked  = !!settings.showEventBanner;
  elHideJoined.checked       = !!settings.hideJoined;
  elKeepDropLog.checked      = !!settings.keepDropLogOnRemove;
  applyIconBarPos();
  applyHostHistoryCols();
  applyHostCategoryFilter();
  updateFilterBlockState();
  setCondPanelOpen(!!settings.condOpen);
  updateCondUI();
  updateLangPicker(settings.lang || 'zh');
}

const setPillValue = (id, v) =>
  document.querySelectorAll(`#${id} .pill`).forEach(b =>
    b.classList.toggle('active', b.dataset.value === String(v)));

const getPillValue = (id, fb) =>
  document.querySelector(`#${id} .pill.active`)?.dataset.value ?? fb;

function setModeToggle(toggleEl, mode) {
  toggleEl.querySelectorAll('.mode-btn').forEach(b =>
    b.setAttribute('aria-pressed', b.dataset.mode === mode ? 'true' : 'false'));
}
const getModeToggle = (toggleEl, fb) =>
  toggleEl.querySelector('.mode-btn[aria-pressed="true"]')?.dataset.mode ?? fb;

function updateLangPicker(lang) {
  document.querySelectorAll('#lang-btns .pill').forEach(b => {
    b.classList.toggle('active', b.dataset.lang === lang);
  });
}

document.getElementById('lang-btns').addEventListener('click', e => {
  const btn = e.target.closest('[data-lang]');
  if (!btn) return;
  const lang = btn.dataset.lang;
  settings.lang = lang;
  applyI18n(lang);
  updateLangPicker(lang);
  updateCondUI();
  saveAll();
  if (activeTab === 'rescue') renderFiltered();
  else refreshHostViews();
});

function getHostCategoryFilters() {
  const cats = settings.hostCategoryFilters;
  return Array.isArray(cats) && cats.length > 0 ? cats : ['all'];
}

function applyHostCategoryFilter() {
  const cats = getHostCategoryFilters();
  if (!elHostCategoryBar) return;
  elHostCategoryBar.querySelectorAll('.cat-chip').forEach(ch =>
    ch.classList.toggle('active', cats.includes(ch.dataset.cat))
  );
}

function applyIconBarPos() {
  document.body.classList.toggle('icon-bar-right', settings.iconBarPos === 'right');
}

function applyHostHistoryCols() {
  document.documentElement.style.setProperty('--host-cols', settings.hostHistoryCols || 3);
}

function readSettingsFromUI() {
  settings.hpOn    = elHpOn.checked;
  settings.hpMode  = getModeToggle(elHpModeToggle, 'above');
  const hpRaw     = parseFloat(elHpVal.value) || 50;
  settings.hpVal  = Math.min(100, Math.max(20, hpRaw));
  settings.memOn   = elMemOn.checked;
  settings.memMode = getModeToggle(elMemModeToggle, 'below');
  const memRaw    = parseInt(elMemVal.value, 10) || 5;
  settings.memVal = Math.min(6, Math.max(1, memRaw));
  settings.bpOn    = elBpOn.checked;
  settings.sort    = elSort.value;
  settings.iconBarPos      = getPillValue('icon-bar-pos-btns', 'left');
  settings.hostHistoryCols = parseInt(getPillValue('host-history-cols-btns', '3'), 10) || 3;
  // hideDepleted はヘッダのトグルボタンが settings を直接更新するのでここでは読まない
  settings.showEventBanner = elShowEventBanner.checked;
  settings.hideJoined      = elHideJoined.checked;
  settings.keepDropLogOnRemove = elKeepDropLog.checked;
}

// ── 条件パネル（HP / 人数 / FP）───────────────────────
// 現在の条件は畳んでいる間も条件ボタンのラベルに要約表示する。
function condSummaryText() {
  const parts = [];
  if (settings.hpOn)  parts.push(`HP${settings.hpMode === 'above' ? '≥' : '≤'}${settings.hpVal}`);
  if (settings.memOn) parts.push(`${t('filterMem')}${settings.memMode === 'above' ? '≥' : '≤'}${settings.memVal}`);
  if (settings.bpOn)  parts.push(t('filterFp'));
  return parts.length ? parts.join(' · ') : t('filterCondNone');
}
function updateCondUI() {
  if (elCondSummary) elCondSummary.textContent = condSummaryText();
  if (btnCond) btnCond.classList.toggle('has-cond', !!(settings.hpOn || settings.memOn || settings.bpOn));
}
function setCondPanelOpen(open) {
  settings.condOpen = !!open;
  if (elCondPanel) elCondPanel.hidden = !settings.condOpen;
  if (btnCond) btnCond.setAttribute('aria-expanded', settings.condOpen ? 'true' : 'false');
}

function updateFilterBlockState() {
  elHpBlock.classList.toggle('disabled', !elHpOn.checked);
  elHpBlock.classList.toggle('active-filter', elHpOn.checked);
  elMemBlock.classList.toggle('disabled', !elMemOn.checked);
  elMemBlock.classList.toggle('active-filter', elMemOn.checked);
  elBpBlock.classList.toggle('disabled', !elBpOn.checked);
  elBpBlock.classList.toggle('active-filter', elBpOn.checked);
}

// ── Tab helper ──────────────────────────────────────
function getGBFTab() {
  return new Promise(resolve => {
    chrome.tabs.query({ url: 'https://game.granbluefantasy.jp/*' }, tabs =>
      resolve(tabs.find(t => t.active) || tabs[0] || null)
    );
  });
}

function getActiveTab() {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => resolve(tabs[0] || null));
  });
}

// ── お気に入りバー ────────────────────────────────────
function favDisplayName(fav) {
  if (!fav) return '';
  return (fav.customName && fav.customName.trim()) || fav.title || fav.url || '';
}

function renderFavBar() {
  const bar = document.getElementById('fav-slots');
  if (!bar) return;
  bar.innerHTML = '';
  for (let i = 0; i < FAV_SLOT_COUNT; i++) {
    const fav = favorites[i];
    const filled = !!fav;
    const slot = document.createElement('div');
    slot.className = 'fav-slot';
    slot.dataset.index = String(i);

    const btn = document.createElement('button');
    btn.className = 'fav-btn' + (filled ? ' filled' : '');
    btn.dataset.index = String(i);
    btn.textContent = filled ? String(i + 1) : '+';
    if (filled) {
      const dn = favDisplayName(fav);
      btn.title = dn ? `${dn}\n${fav.url}` : fav.url;
    }
    slot.appendChild(btn);

    const rm = document.createElement('button');
    rm.className = 'fav-remove' + (filled ? ' visible' : '');
    rm.dataset.index = String(i);
    rm.textContent = '×';
    slot.appendChild(rm);

    const label = document.createElement('div');
    label.className = 'fav-label';
    const labelText = document.createElement('span');
    labelText.className = 'fav-label-text' + (filled ? '' : ' empty');
    labelText.textContent = filled ? favDisplayName(fav) : t('favEmpty');
    label.appendChild(labelText);
    if (filled) {
      const edit = document.createElement('button');
      edit.className = 'fav-edit';
      edit.dataset.index = String(i);
      edit.textContent = '✎';
      edit.title = t('favEditTitle');
      label.appendChild(edit);
    }
    slot.appendChild(label);

    bar.appendChild(slot);
  }
  attachFavBarHandlers();
}

// ── お気に入りバー: ハンドラ（短クリック・長押しD&D・編集・削除） ──
let favDragState = null; // { srcIdx, ghost, justDragged }

function attachFavBarHandlers() {
  const slots = document.querySelectorAll('#fav-bar .fav-slot');
  slots.forEach(slot => {
    const idx = Number(slot.dataset.index);
    const btn = slot.querySelector('.fav-btn');
    const rm  = slot.querySelector('.fav-remove');
    const edit = slot.querySelector('.fav-edit');

    let pressTimer = null;
    let pressUpListener = null;
    let dragModeForThisSlot = false;

    const clearPress = () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
      if (pressUpListener) {
        document.removeEventListener('mouseup', pressUpListener);
        pressUpListener = null;
      }
    };

    btn.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (!favorites[idx]) return; // 空きスロットはドラッグ不可
      const startX = e.clientX, startY = e.clientY;
      pressTimer = setTimeout(() => {
        clearPress();
        dragModeForThisSlot = true;
        beginFavDrag(idx, slot, startX, startY);
      }, FAV_LONGPRESS_MS);
      pressUpListener = () => clearPress();
      document.addEventListener('mouseup', pressUpListener);
      e.preventDefault();
    });

    btn.addEventListener('click', async (e) => {
      // ドラッグ完了直後の click を抑止
      if (favDragState && favDragState.justDragged) return;
      if (dragModeForThisSlot) { dragModeForThisSlot = false; return; }
      const tab = await getActiveTab();
      if (!tab || !tab.url) return;
      if (favorites[idx]) {
        chrome.tabs.update(tab.id, { url: favorites[idx].url, active: true });
      } else {
        favorites[idx] = {
          url: tab.url,
          title: tab.title || '',
          customName: '',
          addedAt: Date.now(),
        };
        saveFavorites();
        renderFavBar();
      }
    });

    if (rm) {
      rm.addEventListener('mousedown', (e) => e.stopPropagation());
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        favorites[idx] = null;
        saveFavorites();
        renderFavBar();
      });
    }

    if (edit) {
      edit.addEventListener('mousedown', (e) => e.stopPropagation());
      edit.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        enterFavRenameMode(slot, idx);
      });
    }
  });
}

// sidepanel iframe 外には描画不可（ブラウザのフレーム分離制約）。
// icon-bar-pos に応じてゴーストを main-content 側へオフセットし、
// それでもはみ出る場合は viewport にクランプして必ず全体が見えるようにする。
function positionFavGhost(ghost, x, y) {
  const ghostW = 22;
  const ghostH = 22;
  const margin = 4;
  const favBarOnRight = !document.body.classList.contains('icon-bar-right');
  let gx = favBarOnRight ? (x - ghostW - 8) : (x + 8);
  let gy = y + 8;
  gx = Math.max(margin, Math.min(window.innerWidth  - ghostW - margin, gx));
  gy = Math.max(margin, Math.min(window.innerHeight - ghostH - margin, gy));
  ghost.style.left = gx + 'px';
  ghost.style.top  = gy + 'px';
}

function beginFavDrag(srcIdx, srcSlot, startX, startY) {
  srcSlot.classList.add('dragging');
  const ghost = document.createElement('div');
  ghost.className = 'fav-ghost';
  ghost.textContent = String(srcIdx + 1);
  positionFavGhost(ghost, startX, startY);
  document.body.appendChild(ghost);
  favDragState = { srcIdx, ghost, justDragged: false };

  const move = (e) => {
    positionFavGhost(ghost, e.clientX, e.clientY);
    document.querySelectorAll('#fav-bar .fav-slot').forEach(s => s.classList.remove('drop-target'));
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const target = el && el.closest ? el.closest('#fav-bar .fav-slot') : null;
    if (target && target !== srcSlot) target.classList.add('drop-target');
  };
  const up = (e) => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const target = el && el.closest ? el.closest('#fav-bar .fav-slot') : null;
    document.querySelectorAll('#fav-bar .fav-slot').forEach(s => s.classList.remove('drop-target'));
    srcSlot.classList.remove('dragging');
    if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
    if (target && target !== srcSlot) {
      const dstIdx = Number(target.dataset.index);
      const [item] = favorites.splice(srcIdx, 1);
      const insertIdx = srcIdx < dstIdx ? dstIdx - 1 : dstIdx;
      favorites.splice(insertIdx, 0, item);
      // 念のため固定長を保証（splice 操作で長さは変わらない想定だが防御的に）
      while (favorites.length < FAV_SLOT_COUNT) favorites.push(null);
      if (favorites.length > FAV_SLOT_COUNT) favorites.length = FAV_SLOT_COUNT;
      saveFavorites();
    }
    favDragState.justDragged = true;
    setTimeout(() => { favDragState = null; }, 50);
    renderFavBar();
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

function enterFavRenameMode(slot, idx) {
  const fav = favorites[idx];
  if (!fav) return;
  const label = slot.querySelector('.fav-label');
  if (!label) return;
  slot.classList.add('renaming');
  const current = fav.customName || fav.title || '';
  label.innerHTML = '';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'fav-rename-input';
  input.maxLength = FAV_NAME_MAX;
  input.value = current;
  input.placeholder = t('favRenamePlaceholder');
  label.appendChild(input);
  // 入力中はラベルの hover 解除や mousedown 伝播を抑止
  input.addEventListener('mousedown', (e) => e.stopPropagation());
  input.addEventListener('click', (e) => e.stopPropagation());

  let finalized = false;
  const finalize = (commit) => {
    if (finalized) return;
    finalized = true;
    slot.classList.remove('renaming');
    if (commit) {
      const v = input.value.trim().slice(0, FAV_NAME_MAX);
      if (favorites[idx]) {
        favorites[idx].customName = v;
        saveFavorites();
      }
    }
    renderFavBar();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finalize(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finalize(false); }
  });
  input.addEventListener('blur', () => finalize(true));
  setTimeout(() => { input.focus(); input.select(); }, 0);
}
function askContent(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, res => {
      if (!chrome.runtime.lastError) { resolve(res); return; }
      const err = chrome.runtime.lastError;
      if (!err.message?.includes('Receiving end does not exist')) { reject(err); return; }
      // content script が切断されている → 再注入してリトライ
      chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }, () => {
        if (chrome.runtime.lastError) { reject(chrome.runtime.lastError); return; }
        chrome.tabs.sendMessage(tabId, msg, res2 =>
          chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(res2)
        );
      });
    });
  });
}

// ── ホーム登録ボタン ──────────────────────────────────
btnHome.addEventListener('click', async () => {
  const tab = await getGBFTab();
  if (!tab) {
    btnHome.classList.add('warn');
    btnHome.title = t('navHomeNoGbf');
    setTimeout(() => {
      btnHome.classList.remove('warn');
      btnHome.title = t('navHomeDefault');
    }, 2000);
    return;
  }
  try {
    const res = await askContent(tab.id, { type: 'GET_CURRENT_URL' });
    const url = res?.url;
    if (!url) return;
    await navigator.clipboard.writeText(url);
    btnHome.classList.add('saved');
    btnHome.title = t('navHomeCopied');
    chrome.tabs.create({ url: 'chrome://settings/appearance' });
    setTimeout(() => {
      btnHome.classList.remove('saved');
      btnHome.title = t('navHomeDefault');
    }, 3000);
  } catch (e) {
    console.error('Home register error:', e);
  }
});

// ── Load ────────────────────────────────────────────
async function load(silent = false) {
  if (isLoading) return;
  isLoading = true;

  allRaids = [];
  // 読み込みテロップは 200ms 以上かかる場合のみ表示する。
  // 高速に完了するケース（新着タブ切替等）でテロップを挟むと一瞬チラつくため、
  // その間は直前のリストを表示したまま完了時に直接差し替える。
  let loadingTelopTimer = null;
  if (!silent) {
    loadingTelopTimer = setTimeout(() => {
      loadingTelopTimer = null;
      setListHTML(`<div class="loading-state"><div class="spinner"></div>${t('msgLoading')}</div>`);
      elCount.innerHTML = t('countEmpty');
    }, 200);
  }
  const clearLoadingTelop = () => {
    if (loadingTelopTimer) { clearTimeout(loadingTelopTimer); loadingTelopTimer = null; }
  };

  const tab = await getGBFTab();
  if (!tab) {
    clearLoadingTelop();
    setListHTML(`<div class="err">${t('msgNoGbf')}</div>`);
    done(); return;
  }
  try {
    const res = await askContent(tab.id, { type: 'GET_RAIDS' });
    if (!res) throw new Error(t('msgNoResponse'));
    allRaids = res.raids || [];
    // クリック参加ログの整理: 新リストに存在しない raidId のみ解放する。
    // RAID_LIST_UPDATED はゲージ変動等の細かい DOM 変化でも発火するため全クリアは不可。
    // 本当のリスト更新では全件入れ替わって自然に空になり、以降は ico-enter 側で判定される。
    // 空リストは遷移中の一時状態の可能性があるためログに触らない。
    if (allRaids.length > 0) {
      const liveIds = new Set(allRaids.map(r => r.raidId));
      for (const id of [...joinedRaidIds]) {
        if (!liveIds.has(id)) joinedRaidIds.delete(id);
      }
    }
    // currentBp は救援タブ DOM 上にしか存在しないため、null の場合は前値を保持
    if (typeof res.currentBp === 'number') {
      currentBP = res.currentBp;
      updateBpDisplay();
      // ロック解除条件は直後の renderFiltered() → render() → evaluateBpLock() で再評価される
    }
    // ※ 救援レイド一覧由来のサムネイルは questMeta に保存しない（マイクエスト側で利用しないため）。
    //    救援タブのカード描画は raid オブジェクトの r.thumbnailSrc を直接読むので影響なし。
    const now = new Date();
    elUpdated.textContent = `${now.getHours()}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    clearLoadingTelop();
    renderFiltered();
  } catch (e) {
    clearLoadingTelop();
    setListHTML(`<div class="err">${t('msgError', { msg: e.message })}</div>`);
  }
  done();
}
function done() { isLoading = false; }
function pad(n) { return String(n).padStart(2, '0'); }

// ── ゲーム側更新 ─────────────────────────────────────
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'RAID_LIST_UPDATED') {
    if (activeTab === 'rescue') load(true);
  } else if (message.type === 'RAID_TAB_SWITCHED') {
    if (activeTab === 'rescue') load(false);
  } else if (message.type === 'SELF_HOST_DETECTED') {
    const detectKey = `${message.questId}:${message.questType}:${message.treasureId || ''}`;
    const now = Date.now();
    // 同一自発イベントの短時間重複受信を抑止
    if (detectKey === lastHostDetectKey && (now - lastHostDetectAt) < 2000) return;
    lastHostDetectKey = detectKey;
    lastHostDetectAt  = now;

    const fromMyQuest = consumePanelHostExpect(message.questId);
    // 戻る起点（hash-source）の自発検出: サポート石ページへ戻る→再受注のパス。
    // raidCategory が不明なため、既存エントリの分類を上書きしない / 未取得は取得しない。
    // リザルト [もう一度挑戦] (message.isRetry) も result ページから category を判定できないため同等に扱う。
    const fromBackNav = message.source === 'hash' || message.isRetry === true;

    checkDailyReset();
    const existing = hostHistory.find(r => String(r.questId) === String(message.questId));

    // 戻る起点で hostHistory に無いクエストは取得しない（使い方の制限で対応）
    if (fromBackNav && !existing) {
      return;
    }

    // マイクエスト経由 または 戻る起点の再受注: 難易度・questMeta 分類は触らず、本日回数と残り自発回数だけ更新
    if ((fromMyQuest || fromBackNav) && existing) {
      existing.todayCount    = (existing.todayCount || 0) + 1;
      existing.lastTimestamp = now;
      if (!questMeta[message.questId]) questMeta[message.questId] = {};
      const qm = questMeta[message.questId];
      // PRO quest は proQuestSkip、非 PRO は limitedCount を減算
      if (qm.raidCategory === 'pro' || message.isProQuest) {
        if (Number.isFinite(qm.proQuestSkip)) {
          qm.proQuestSkip = Math.max(0, qm.proQuestSkip - 1);
        }
      } else if (Number.isFinite(qm.limitedCount)) {
        qm.limitedCount = Math.max(0, qm.limitedCount - 1);
      }
      if (message.hostThumbnailSrc) {
        qm.hostThumbnailSrc = message.hostThumbnailSrc;
      }
      recentHostDecrementAt[message.questId] = now;
      saveHostHistory();
      refreshHostViews();
      return;
    }

    // questId ごとに 1 エントリ。既存があれば todayCount をインクリメント、無ければ新規追加（ゲーム内一覧から）
    if (existing) {
      existing.todayCount    = (existing.todayCount || 0) + 1;
      existing.lastTimestamp = now;
      existing.questType     = message.questType;
      existing.treasureId    = message.treasureId || existing.treasureId || '';
      existing.raidCategory  = message.raidCategory || existing.raidCategory || 'etc';
      if (Number.isFinite(message.eventPeriodEndMs)) {
        existing.eventPeriodEndMs = message.eventPeriodEndMs;
      }
      // 既存値があれば上書きしない (古い event 紐付けを誤って消すのを防ぐ)
      if (!existing.eventName && typeof message.eventName === 'string' && message.eventName) {
        existing.eventName = message.eventName;
      }
    } else {
      const row = {
        questId:       message.questId,
        questType:     message.questType,
        treasureId:    message.treasureId || '',
        lastTimestamp: now,
        todayCount:    1,
        raidCategory:  message.raidCategory || 'etc',
      };
      if (Number.isFinite(message.eventPeriodEndMs)) {
        row.eventPeriodEndMs = message.eventPeriodEndMs;
      }
      if (typeof message.eventName === 'string' && message.eventName) {
        row.eventName = message.eventName;
      }
      hostHistory.push(row);
    }
    // 自発クリック時のメタデータを反映
    if (!questMeta[message.questId]) {
      questMeta[message.questId] = {};
    }
    if (message.chapterName) {
      questMeta[message.questId].chapterName = message.chapterName;
    }
    if (message.raidCategory) {
      questMeta[message.questId].raidCategory = message.raidCategory;
    }
    if (message.hostThumbnailSrc) {
      questMeta[message.questId].hostThumbnailSrc = message.hostThumbnailSrc;
    }
    if (typeof message.limitedCount === 'number' && Number.isFinite(message.limitedCount)) {
      // data-limited_count は参加前の残り回数なので、参加後表示用に 1 減算する
      questMeta[message.questId].limitedCount = Math.max(0, message.limitedCount - 1);
    } else if (Number.isFinite(questMeta[message.questId].limitedCount)) {
      // マイクエストカード経由などで limitedCount が届かない場合は、保持中の値を 1 減算
      questMeta[message.questId].limitedCount = Math.max(0, questMeta[message.questId].limitedCount - 1);
    }
    if (typeof message.maxLimitedCount === 'number' && message.maxLimitedCount > 0) {
      questMeta[message.questId].maxLimitedCount = message.maxLimitedCount;
    }
    // 最終フォールバック: max が取得できないまま limitedCount > 0 なら、
    // 参加前の message.limitedCount（= 減算前の値）を max として固定採用する
    if (!Number.isFinite(questMeta[message.questId].maxLimitedCount)
        && typeof message.limitedCount === 'number'
        && message.limitedCount > 0) {
      questMeta[message.questId].maxLimitedCount = message.limitedCount;
    }
    // PRO quest: proQuestSkip を 1 減算。maxProQuestSkip 未設定ならクリック時の値で確定
    if (message.isProQuest) {
      questMeta[message.questId].raidCategory = 'pro';
      const qm = questMeta[message.questId];
      if (Number.isFinite(message.proQuestSkip)) {
        if (!Number.isFinite(qm.maxProQuestSkip)) {
          qm.maxProQuestSkip = message.proQuestSkip;
        }
        qm.proQuestSkip = Math.max(0, message.proQuestSkip - 1);
      } else if (Number.isFinite(qm.proQuestSkip)) {
        qm.proQuestSkip = Math.max(0, qm.proQuestSkip - 1);
      }
    }
    recentHostDecrementAt[message.questId] = now;
    pruneExpiredEventAdventHosts();
    saveHostHistory();
    refreshHostViews();
  } else if (message.type === 'QUEST_META_UPDATED') {
    const entries = message.questMeta || [];
    const now = Date.now();
    const META_GUARD_MS = 10000;
    for (const e of entries) {
      const prev = questMeta[e.questId] || {};
      const merged = { ...prev, ...e, updatedAt: now };
      // 空文字の questThumbnailSrc が届いたら prev を保持
      if (!e.questThumbnailSrc && prev.questThumbnailSrc) {
        merged.questThumbnailSrc = prev.questThumbnailSrc;
      }
      const hasIncomingLimited = Number.isFinite(e.limitedCount);
      const hasPrevLimited = Number.isFinite(prev.limitedCount);
      const inGuardWindow = (now - (recentHostDecrementAt[e.questId] || 0)) < META_GUARD_MS;

      // 自発直後は、古いDOM値で limitedCount が増える上書きを抑止。
      // Hell も対象 (extractEventTabHellMeta が consume 直後の stale DOM を読み戻し
      //  pre-consume 値で上書きしてしまうため。マイクエ hell skip 経路で必発)。
      // クリア確率増による正常な増加は recentHostDecrementAt の guard window を超えてから
      // 次の extract で反映される。
      const isHellEntry = !!(prev.isHellQuest || e.isHellQuest);
      if (hasIncomingLimited && hasPrevLimited && inGuardWindow && e.limitedCount > prev.limitedCount) {
        merged.limitedCount = prev.limitedCount;
      }

      // Hell の max は consume 直後の guard window 内では stale extract によるロールバックを抑止する。
      // 0 になった hell の lis-event-list が DOM から消える前 / 残count 描画が更新される前の
      // 古い extract が、post-consume 値を pre-consume 値に巻き戻すのを防ぐ。
      // ガード外であれば extract の値 (n1=n2) をそのまま採用し、ユーザ仕様 (n2 常に n1 と同値) を保つ。
      if (isHellEntry
          && Number.isFinite(prev.maxLimitedCount)
          && Number.isFinite(e.maxLimitedCount)
          && inGuardWindow
          && e.maxLimitedCount > prev.maxLimitedCount) {
        merged.maxLimitedCount = prev.maxLimitedCount;
      }

      // PRO quest: maxProQuestSkip は「5時以降の初回DOM値」を固定採用
      if (e.isProQuest) {
        merged.raidCategory = 'pro';
        if (Number.isFinite(e.proQuestSkip)) {
          if (!Number.isFinite(prev.maxProQuestSkip)) {
            // 初回取得: max と remaining を同値で確定
            merged.maxProQuestSkip = e.proQuestSkip;
            merged.proQuestSkip    = e.proQuestSkip;
          } else if (inGuardWindow && Number.isFinite(prev.proQuestSkip) && e.proQuestSkip > prev.proQuestSkip) {
            // 自発直後の古いDOM戻りを抑止
            merged.proQuestSkip = prev.proQuestSkip;
          }
          // max 確定後・ガード外は spread 済みの e.proQuestSkip がそのまま採用される
        }
      }

      // max 相当の値が DOM から得られない時の最終フォールバック
      applyMaxLimitedCountFallback(merged);

      questMeta[e.questId] = merged;

      // hell エントリは同一 dataid の sibling にも回数を伝播（将来 V2 復活時の保険）
      if (merged.isHellQuest) {
        syncHellLimitedAcrossSiblings(e.questId);
      }
    }
    saveHostHistory();
    refreshHostViews();
  } else if (message.type === 'HELL_QUEST_CONSUMED') {
    // Hell は PT選択 (#quest/supporter) OK + hashchange 離脱で確定発火。
    // questId は content.js 側で合成された `hell_<dataId>_<dataGroup>`。
    const now = Date.now();
    checkDailyReset();
    const qid = message.questId;
    if (!qid) return;

    if (!questMeta[qid]) questMeta[qid] = {};
    const qm = questMeta[qid];
    qm.isHellQuest  = true;
    qm.raidCategory = 'event';
    if (message.chapterName)      qm.chapterName      = message.chapterName;
    if (message.hostThumbnailSrc) qm.hostThumbnailSrc = message.hostThumbnailSrc;

    // skip 観測時のみ hellSkipParams を保存。マイクエタイル click 時の直遷移 URL に使う。
    // lastUsedSkipCount は直遷移時に sidepanel 側で更新するため既存値を保持する。
    if (message.hellSkipParams) {
      const prev = qm.hellSkipParams || {};
      qm.hellSkipParams = {
        ...prev,
        ...message.hellSkipParams,
        lastUsedSkipCount: prev.lastUsedSkipCount ?? null,
      };
    }

    if (Number.isFinite(message.limitedCountAfter)) {
      qm.limitedCount = message.limitedCountAfter;
    } else {
      const consumed = Number.isFinite(message.consumedCount) ? message.consumedCount : 1;
      if (Number.isFinite(qm.limitedCount)) {
        qm.limitedCount = Math.max(0, qm.limitedCount - consumed);
      }
    }
    // hell の n2 (maxLimitedCount) は常に n1 (limitedCount) と同じ値にする（ユーザ仕様）。
    // 「残り 0/0 回」表記で枯渇を表示し、clear chance bonus による増加は extractEventTabHellMeta
    // 経路で n1 = n2 同期される。
    if (Number.isFinite(qm.limitedCount)) {
      qm.maxLimitedCount = qm.limitedCount;
    }

    // 同一 dataid の sibling hell（レベル別カード）にも回数を伝播
    syncHellLimitedAcrossSiblings(qid);

    const existing = hostHistory.find(r => String(r.questId) === String(qid));
    if (existing) {
      existing.todayCount    = (existing.todayCount || 0) + 1;
      existing.lastTimestamp = now;
      existing.raidCategory  = 'event';
      if (Number.isFinite(message.eventPeriodEndMs)) {
        existing.eventPeriodEndMs = message.eventPeriodEndMs;
      }
      if (!existing.eventName && typeof message.eventName === 'string' && message.eventName) {
        existing.eventName = message.eventName;
      }
    } else {
      const row = {
        questId:       qid,
        questType:     '',
        treasureId:    '',
        lastTimestamp: now,
        todayCount:    1,
        raidCategory:  'event',
      };
      if (Number.isFinite(message.eventPeriodEndMs)) row.eventPeriodEndMs = message.eventPeriodEndMs;
      if (typeof message.eventName === 'string' && message.eventName) row.eventName = message.eventName;
      hostHistory.push(row);
    }

    recentHostDecrementAt[qid] = now;
    saveHostHistory();
    refreshHostViews();
  } else if (message.type === 'ENEMY_IMG_RESOLVED') {
    if (message.questId && message.thumbnailSrc) {
      if (!questMeta[message.questId]) questMeta[message.questId] = {};
      questMeta[message.questId].enemyImgSrc = message.thumbnailSrc;
      saveHostHistory();
      refreshHostViews();
    }
  } else if (message.type === 'EVENT_INFO_DETECTED') {
    const k = String(message.eventName || '').trim();
    if (!k) return;
    // 本開催イベント (#event/...) 受信時、同一タイトルの teaser / teaser 昇格エントリを統合削除する。
    // teaser ID (#teaser/N) と本開催 event ID は一致しない場合があるため、ID ではなくタイトルで照合し、
    // 本物の hash を持つエントリ 1 件へまとめる（重複バナー・遷移失敗の原因を断つ）。
    // teaser から取得済みの eventStartMs/eventEndMs は本開催側へ引き継ぐ。
    if (!message.isTeaser) {
      const incomingTitle = String(message.title || '').trim();
      if (incomingTitle) {
        for (const ek of Object.keys(activeEvents)) {
          if (ek === k) continue;
          const ee = activeEvents[ek];
          if (!ee || !(ee.isTeaser || ee.promotedFromTeaser)) continue;
          if (String(ee.title || '').trim() !== incomingTitle) continue;
          if (!Number.isFinite(message.eventStartMs) && Number.isFinite(ee.eventStartMs)) message.eventStartMs = ee.eventStartMs;
          if (!Number.isFinite(message.eventEndMs)   && Number.isFinite(ee.eventEndMs))   message.eventEndMs   = ee.eventEndMs;
          delete activeEvents[ek];
        }
      }
    }
    const existing = activeEvents[k];
    activeEvents[k] = {
      eventName:    k,
      title:        String(message.title || '').trim() || k,
      periodText:   String(message.periodText || ''),
      periodEndMs:  Number.isFinite(message.periodEndMs) ? message.periodEndMs : (existing?.periodEndMs ?? null),
      hash:         typeof message.hash === 'string' ? message.hash : '',
      isTeaser:     !!message.isTeaser,
      isEnding:     !!message.isEnding,
      // 一度 is-event-end を観測したら終了扱いを保持（再訪で復活させない）。
      isEventEnd:   !!message.isEventEnd || !!existing?.isEventEnd,
      isRewardClaim: !!message.isRewardClaim,
      lastSeenAt:   Date.now(),
      eventStartMs: Number.isFinite(message.eventStartMs) ? message.eventStartMs : (existing?.eventStartMs ?? null),
      eventEndMs:   Number.isFinite(message.eventEndMs)   ? message.eventEndMs   : (existing?.eventEndMs   ?? null),
    };
    // バナー表示（eventBanners）へ開催期間を反映。path = hash から # を除いた値で照合。
    // mypage で未観測のイベントページ訪問ではバナーを新規作成しない（表示は mypage 由来のみ）。
    const bp = (typeof message.hash === 'string' ? message.hash : '').replace(/^#/, '');
    if (bp && eventBanners[bp]) {
      const b = eventBanners[bp];
      if (message.periodText) b.periodText = String(message.periodText);
      if (Number.isFinite(message.eventStartMs)) b.eventStartMs = message.eventStartMs;
      if (Number.isFinite(message.eventEndMs))   b.eventEndMs   = message.eventEndMs;
      // 終了マーカーは sticky。バナーを「開催終了」群へ固定し、未来日の報酬期間で復活させない。
      if (message.isEventEnd) b.isEventEnd = true;
      b.lastSeenAt = Date.now();
    }
    pruneExpiredActiveEvents();
    // activeEvents 変動に同期して hostHistory 側の event エントリも掃除する
    //  (eventName 照合経路を即時反映するため)。
    pruneExpiredEventAdventHosts();
    saveHostHistory();
    refreshHostViews();
  } else if (message.type === 'EVENT_BANNER_DETECTED') {
    // mypage グローバルバナー検出。path（=data-href）をキーに upsert。
    const path = String(message.path || '').trim();
    if (!path) return;
    const now = Date.now();
    let b = eventBanners[path];
    const isNew = !b;
    if (!b) {
      b = eventBanners[path] = {
        path, hash: '#' + path, bannerSrc: '', srcUrl: '',
        isTeaser: !!message.isTeaser,
        periodText: '', eventStartMs: null, eventEndMs: null,
        lastSeenAt: now,
      };
    }
    const teaserChanged = b.isTeaser !== !!message.isTeaser;
    b.isTeaser = !!message.isTeaser;
    b.hash = '#' + path;
    b.lastSeenAt = now;
    // 画像が base64 取得済みなら再 fetch しない（freeze）。lastSeenAt のみ更新。
    // 未取得（新規／URL のまま）かつ未依頼のときだけ暫定 URL を立て background へ取得依頼する。
    const cached = String(b.bannerSrc || '').startsWith('data:');
    let visualChanged = isNew || teaserChanged;
    if (!cached && !bannerFetchPending.has(path) && typeof message.imgUrl === 'string' && message.imgUrl) {
      if (!b.bannerSrc) { b.bannerSrc = message.imgUrl; b.srcUrl = message.imgUrl; visualChanged = true; }
      bannerFetchPending.add(path);
      chrome.runtime.sendMessage({ type: 'EVENT_BANNER_FETCH', path, imgUrl: b.srcUrl }).catch(() => {});
    }
    saveHostHistory();
    // 見た目が変わらない再観測（取得済みバナーの lastSeenAt 更新のみ）では再描画しない。
    if (visualChanged) refreshHostViews();
  } else if (message.type === 'MYPAGE_BANNERS_SWEEP') {
    // mypage グローバルバナーの 1 スイープ完了通知。
    // 今回 sweep の paths に含まれない Teaser バナーは即削除する（掲載終了・本開催への切替えに追従）。
    // event/... バナーは判定対象外（既存の 14 日 TTL に委ねる）。
    const arr = Array.isArray(message.paths) ? message.paths : [];
    const seen = new Set(arr);
    let changed = false;
    for (const k of Object.keys(eventBanners)) {
      const b = eventBanners[k];
      if (!b || !b.isTeaser) continue;
      if (!seen.has(k)) {
        delete eventBanners[k];
        changed = true;
      }
    }
    if (changed) {
      saveHostHistory();
      refreshHostViews();
    }
  } else if (message.type === 'DROP_LOGGED') {
    // content.js が検出したリザルト画面ドロップを「取得イベント」として時系列に積む。
    // 同じアイテムが別タイミングで落ちれば別エントリ。最新 10 件のみ保持し超過分は破棄。
    // resultKey で永続 dedupe（content.js 側の session 内 dedupe を再起動跨ぎでも維持）。
    const key  = String(message.resultKey || '');
    const hits = Array.isArray(message.hits) ? message.hits : [];
    if (!key || hits.length === 0) return;
    if (seenResultKeys[key]) return; // 既に集計済み
    seenResultKeys[key] = Number.isFinite(message.detectedAt) ? message.detectedAt : Date.now();
    const now = Number.isFinite(message.detectedAt) ? message.detectedAt : Date.now();
    for (const h of hits) {
      const wid = String(h.watchId || '');
      if (!wid) continue;
      const cnt = Number.isFinite(h.count) ? Math.max(0, h.count) : 0;
      if (cnt === 0) continue;
      dropEvents.unshift({ watchId: wid, at: now, count: cnt });
    }
    pruneDropEvents();
    if (pruneDropWatchArchive()) saveDropWatchArchive();
    chrome.storage.local.set({ gbfRfDropEvents: dropEvents, gbfRfSeenResultKeys: seenResultKeys });
    if (activeTab === 'dashboard') renderDashboard();
  } else if (message.type === 'RECENT_DROPS_DETECTED') {
    // 直近 1 リザルト分の全ドロップ。蓄積せず置換のみ。storage 書き込みなし。
    // 表示用 URL（s/.jpg）は描画時に buildIconUrl() で組み立てる。
    const drops = Array.isArray(message.drops) ? message.drops : [];
    lastResultDrops = drops.filter(d => d && d.category && d.itemId);
    renderRecentDropsFooter();
  } else if (message.type === 'DROP_ICON_RESOLVED') {
    // background が base64 dataURL 化した結果を gbfRfDropWatch[i].iconCached に焼き付け。
    const wid = String(message.watchId || '');
    dropIconFetchPending.delete(wid);
    if (!wid) return;
    const entry = dropWatch.find(w => w.id === wid);
    if (!entry) return;
    if (typeof message.iconCached === 'string' && message.iconCached) {
      entry.iconCached = message.iconCached;
      saveDropWatch();
      // 設定パネル・ダッシュボード・フッターを再描画してアイコン即時反映
      renderDropWatchEditor();
      if (activeTab === 'dashboard') renderDashboard();
    }
  } else if (message.type === 'EVENT_BANNER_RESOLVED') {
    // background が base64 dataURL 化した結果。最初に観測した画像 (srcUrl) のみ durable へ差し替え。
    const path = String(message.path || '').trim();
    const b = path ? eventBanners[path] : null;
    bannerFetchPending.delete(path); // 成否に関わらず pending 解除
    if (!b) return;
    if (typeof message.bannerSrc === 'string' && message.bannerSrc
        && message.imgUrl === b.srcUrl
        && !String(b.bannerSrc || '').startsWith('data:')) {
      b.bannerSrc = message.bannerSrc;
      saveHostHistory();
      refreshHostViews();
    }
  }
});

// ── Template ─────────────────────────────────────────
function filterSnapshot(name) {
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    name,
    hpOn: settings.hpOn, hpMode: settings.hpMode, hpVal: settings.hpVal,
    memOn: settings.memOn, memMode: settings.memMode, memVal: settings.memVal,
    bpOn: settings.bpOn,
  };
}
function applyTemplate(tpl) {
  activeTplId = tpl.id;
  settings.hpOn = tpl.hpOn; settings.hpMode = tpl.hpMode;
  settings.hpVal = Math.min(100, Math.max(20, (parseFloat(tpl.hpVal) || 50)));
  settings.memOn = tpl.memOn; settings.memMode = tpl.memMode;
  settings.memVal = Math.min(6, Math.max(1, (parseInt(tpl.memVal, 10) || 5)));
  settings.bpOn = tpl.bpOn ?? false;
  applySettingsToUI(); saveAll(); renderTemplates(); renderFiltered();
}
function deleteTemplate(id) {
  templates = templates.filter(t => t.id !== id);
  if (activeTplId === id) activeTplId = null;
  saveAll(); renderTemplates();
}
function renderTemplates() {
  templateScroll.innerHTML = '';
  templates.forEach(tpl => {
    const chip = document.createElement('div');
    chip.className = 'tpl-chip' + (tpl.id === activeTplId ? ' active-tpl' : '');
    chip.innerHTML = `<button type="button" class="tpl-chip-name">${esc(tpl.name)}</button>`
                   + `<button type="button" class="tpl-chip-del" title="${esc(t('templateDeleteTitle'))}" aria-label="${esc(t('templateDeleteTitle'))}">✕</button>`;
    chip.querySelector('.tpl-chip-name').addEventListener('click', () => applyTemplate(tpl));
    chip.querySelector('.tpl-chip-del').addEventListener('click', (e) => { e.stopPropagation(); deleteTemplate(tpl.id); });
    templateScroll.appendChild(chip);
  });
}
function openTplNameRow() { tplNameRow.classList.add('open'); tplNameInput.value = ''; tplNameInput.focus(); }
function closeTplNameRow() { tplNameRow.classList.remove('open'); tplNameInput.value = ''; }

// ── Filter / Sort ─────────────────────────────────────
// 参加済み = 本体の参戦中アイコン(ico-enter) or 現リストでのクリック参加ログ
function isJoinedRaid(r) {
  return r.hasEnterIcon || joinedRaidIds.has(r.raidId);
}
function filtered() {
  let r = [...allRaids];
  if (settings.hpOn) {
    const v = settings.hpVal;
    r = r.filter(x => x.hpPercent !== null && (settings.hpMode === 'above' ? x.hpPercent >= v : x.hpPercent <= v));
  }
  if (settings.memOn) {
    const v = settings.memVal;
    r = r.filter(x => x.memberCurrent !== null && (settings.memMode === 'above' ? x.memberCurrent >= v : x.memberCurrent <= v));
  }
  if (settings.bpOn) {
    r = r.filter(x => x.bpDecreased);
  }
  if (settings.hideJoined) {
    r = r.filter(x => !isJoinedRaid(x));
  }
  const toSec = t => { if (!t) return 9999999; const p = t.split(':').map(Number).reverse(); return (p[0]||0)+(p[1]||0)*60+(p[2]||0)*3600; };
  switch (settings.sort) {
    case 'hp-asc':   r.sort((a,b)=>(a.hpPercent??999)-(b.hpPercent??999)); break;
    case 'hp-desc':  r.sort((a,b)=>(b.hpPercent??-1)-(a.hpPercent??-1));   break;
    case 'mem-asc':  r.sort((a,b)=>(a.memberCurrent??999)-(b.memberCurrent??999)); break;
    case 'mem-desc': r.sort((a,b)=>(b.memberCurrent??-1)-(a.memberCurrent??-1));   break;
    case 'time-asc': r.sort((a,b)=>toSec(a.remainingTime)-toSec(b.remainingTime)); break;
  }
  return r;
}
function renderFiltered() {
  const r = filtered();
  elCount.innerHTML = `<span>${r.length}</span> / ${allRaids.length} ${t('countUnit')}`;
  render(r);
}

// ── Render ────────────────────────────────────────────
function hpCls(p) { return p===null?'': p>=70?'g': p>=30?'o':'r'; }
// HP バーの色は CSS トークン（--hp-*）を唯一の定義元にする
const rootStyle = getComputedStyle(document.documentElement);
function cssVar(name, fallback) {
  const v = (rootStyle.getPropertyValue(name) || '').trim();
  return v || fallback;
}
function hpCol(p) {
  return (p === null || p >= 70) ? cssVar('--hp-g', '#3eb503')
       : (p >= 30)               ? cssVar('--hp-o', '#ffa826')
       :                           cssVar('--hp-r', '#ff6a33');
}
function bpHtml(n, half) {
  let d = ''; for (let i = 0; i < 5; i++) d += `<span class="bp-dot${i<n?' on':''}"></span>`;
  return `<span class="bp-row">${d}</span>${half?'<span class="bp-half">½</span>':''}`;
}
// カード本体（サムネ + 3 ティア構成の info）。tail は row3 右端に置く追加要素。
function cardBodyHTML(r, tail) {
  const h   = r.hpPercent !== null ? `${r.hpPercent.toFixed(0)}%` : '—';
  const mem = r.memberCurrent !== null ? `${r.memberCurrent}<i>/${r.memberMax}</i>` : '—';
  const nm  = esc(r.chapterName.length > 24 ? r.chapterName.slice(0,24)+'…' : r.chapterName);
  return `
  <img class="thumb" src="${esc(r.thumbnailSrc)}" alt="" loading="lazy">
  <span class="info">
    <span class="row1"><span class="name">${nm}</span><span class="time">${esc(r.remainingTime)}</span></span>
    <span class="row2"><span class="hp-val ${hpCls(r.hpPercent)}">${h}</span><span class="hp-bar"><span class="hp-fill" style="width:${r.hpPercent??0}%;background:${hpCol(r.hpPercent)}"></span></span></span>
    <span class="row3"><span class="mem">${mem}</span>${bpHtml(r.bp, r.isHalf)}${tail || ''}</span>
  </span>`;
}

function setListHTML(html) {
  elList.innerHTML = html;
}

function render(raids) {
  if (allRaids.length === 0) {
    setListHTML(`<div class="state"><div class="ico">🔍</div><p>${t('msgNoRaids')}</p></div>`);
    return;
  }
  if (raids.length === 0) {
    setListHTML(`<div class="state"><div class="ico">⚙️</div><p>${t('msgNoFilter')}</p></div>`);
    return;
  }

  // 未知クラスカードを最下部に
  const normal  = raids.filter(r => !r.isUnknown);
  const unknown = raids.filter(r =>  r.isUnknown);
  const sorted  = [...normal, ...unknown];

  elList.innerHTML = sorted.map(r => {
    if (r.isUnknown) {
      // 種別未判定レイド: 赤枠での警告ではなく、点線＋面なしで最下部に降格表示する
      const tail = `<span class="tag-unknown">${esc(t('raidUnknownTag'))}</span>`;
      return `
<div class="card card-unknown" title="${esc(t('raidTitleUnknown', { cls: r.unknownClasses.join(',') }))}">${cardBodyHTML(r, tail)}
</div>`;
    }
    const joined = isJoinedRaid(r);
    const tail = joined ? `<span class="badge-joined">${esc(t('raidJoinedBadge'))}</span>` : '';
    return `
<button type="button" class="card${joined ? ' joined' : ''}" data-raid-id="${esc(r.raidId)}" data-raid-url="${esc(r.raidUrl||'')}"
     data-thumb="${esc(r.thumbnailSrc)}" data-name="${esc(r.chapterName)}" data-bp="${r.bp|0}" title="${esc(t('raidClickJoin'))}">${cardBodyHTML(r, tail)}
</button>`;
  }).join('');
  elList.querySelectorAll('button.card').forEach(card => {
    card.addEventListener('click', () => joinRaid(card, {
      raidId:       card.dataset.raidId,
      raidUrl:      card.dataset.raidUrl,
      thumbnailSrc: card.dataset.thumb,
      chapterName:  card.dataset.name,
      bp:           parseInt(card.dataset.bp, 10) || 0,
    }));
  });
  // 表示中レイドの BP コストと currentBP を比較し、必要ならロック発動 / 解除
  evaluateBpLock(raids);
}

// ── BP 表示・ロック制御 ───────────────────────────────
function updateBpDisplay() {
  if (!elBpDisplayValue) return;
  elBpDisplayValue.textContent = (currentBP === null) ? '--' : String(currentBP);
  if (elBpDisplay) {
    elBpDisplay.classList.toggle('shortage', panelLockUntilBp !== null);
  }
}

function lockPanel(requiredBp) {
  panelLockUntilBp = requiredBp;
  if (elList) elList.classList.add('bp-locked');
  if (elBpShortageBanner) elBpShortageBanner.hidden = false;
  updateBpDisplay();
}

function unlockPanel() {
  panelLockUntilBp = null;
  if (elList) elList.classList.remove('bp-locked');
  if (elBpShortageBanner) elBpShortageBanner.hidden = true;
  updateBpDisplay();
}

// ── BP ロック評価（render 時に呼ぶ） ──────────────────────
// 表示中レイドのいずれかが currentBP で参加不可ならロック発動。
// 全枚参加可能なら自動解除。currentBP=null（救援タブ未取得）は既存状態維持。
// 評価対象は filtered() 通過後の表示分のみ。hidden パネルは判定に含まれない。
function evaluateBpLock(raids) {
  if (currentBP === null) return;

  const bps = raids
    .filter(r => !r.isUnknown && typeof r.bp === 'number' && r.bp > 0)
    .map(r => r.bp);

  if (bps.length === 0) {
    if (panelLockUntilBp !== null) unlockPanel();
    return;
  }

  const maxBp = Math.max(...bps);
  if (currentBP < maxBp) {
    lockPanel(maxBp);
  } else if (panelLockUntilBp !== null) {
    unlockPanel();
  }
}

// ── Join（URLジャンプ固定） ────────────────────────────
async function joinRaid(card, raid) {
  if (card.classList.contains('joining')) return;

  // ロック中はクリック無効（pointer-events:none で通常到達しないが念のため）
  if (panelLockUntilBp !== null) return;

  // フォールバック: render 後に currentBP が変動した稀ケース対応
  // ToS 規約により GBF API 直接呼び出しはできないため、本体側での回復を促す
  if (currentBP !== null && raid.bp > 0 && currentBP < raid.bp) {
    lockPanel(raid.bp);
    return;
  }

  card.classList.add('joining');

  const tab = await getGBFTab();
  if (!tab) { card.classList.remove('joining'); return; }
  try {
    if (raid.raidUrl) {
      const fullUrl = 'https://game.granbluefantasy.jp/' + raid.raidUrl;
      await chrome.tabs.update(tab.id, { url: fullUrl, active: true });
      card.classList.add('joined');
      joinedRaidIds.add(raid.raidId);
      if (joinedRaidIds.size > JOINED_LOG_MAX) {
        joinedRaidIds.delete(joinedRaidIds.values().next().value);
      }
      // 非表示設定 ON なら参加したカードを即座にリストから除去する
      if (settings.hideJoined) renderFiltered();
    }
  } catch (e) {
    console.error('Join error:', e);
  }
  card.classList.remove('joining');
}

// ── Utils ─────────────────────────────────────────────
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── 新リリース通知（GitHub Releases） ──────────────────
// tag_name("v1.4.3") を manifest version と semver 比較し、新しければバナー表示。
// fetch は api.github.com（ACAO:* のため host_permissions 不要）。前回チェックから
// UPDATE_CHECK_INTERVAL_MS 未満なら fetch せず保存済み状態のみで描画する。
function compareSemver(a, b) {
  const norm = (s) => String(s || '').trim().replace(/^v/i, '').split('-')[0].split('.').map(n => parseInt(n, 10));
  const pa = norm(a), pb = norm(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}
function isNewerVersion(latest, current) {
  return compareSemver(latest, current) > 0;
}

function renderUpdateBanner(state) {
  const banner = document.getElementById('update-banner');
  if (!banner) return;
  const current = chrome.runtime.getManifest().version;
  const show = state && state.latestTag
    && isNewerVersion(state.latestTag, current)
    && state.dismissedTag !== state.latestTag;
  if (!show) { banner.hidden = true; return; }

  const vText = esc(state.latestTag).replace(/^v/i, '');
  const textEl = document.getElementById('update-banner-text');
  if (textEl) textEl.textContent = t('updateBannerText', { v: vText });
  // 外部由来 URL。https のみ許可（javascript: 等の混入防止）
  banner.href = /^https:\/\//.test(state.latestUrl || '') ? state.latestUrl : '#';
  banner.hidden = false;
}

async function checkForUpdate() {
  let state = {};
  try {
    const data = await chrome.storage.local.get('gbfRfUpdateState');
    state = data.gbfRfUpdateState || {};
  } catch { return; }

  // まず保存済み状態で即描画（前回 latestTag が dismiss 済みでなければ出す）
  renderUpdateBanner(state);

  // lazy: 前回チェックから一定時間未経過なら fetch しない
  if (state.lastCheckedAt && (Date.now() - state.lastCheckedAt) < UPDATE_CHECK_INTERVAL_MS) return;

  let json;
  try {
    const res = await fetch(UPDATE_RELEASE_API, { headers: { 'Accept': 'application/vnd.github+json' } });
    if (!res.ok) {
      // 403(レート)/404 等 → lastCheckedAt だけ更新して静かに終了
      state.lastCheckedAt = Date.now();
      await chrome.storage.local.set({ gbfRfUpdateState: state });
      return;
    }
    json = await res.json();
  } catch { return; }  // ネットワーク失敗 → 静かに無視

  const next = {
    lastCheckedAt: Date.now(),
    latestTag: typeof json.tag_name === 'string' ? json.tag_name : '',
    latestUrl: typeof json.html_url === 'string' ? json.html_url : '',
    dismissedTag: state.dismissedTag || '',
  };
  await chrome.storage.local.set({ gbfRfUpdateState: next });
  renderUpdateBanner(next);
}

async function dismissUpdateBanner(e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  try {
    const data = await chrome.storage.local.get('gbfRfUpdateState');
    const state = data.gbfRfUpdateState || {};
    state.dismissedTag = state.latestTag || '';
    await chrome.storage.local.set({ gbfRfUpdateState: state });
  } catch {}
  const banner = document.getElementById('update-banner');
  if (banner) banner.hidden = true;
}

// ── GBF日付（JST 5:00リセット） ─────────────────────
function getGBFDateString(now = new Date()) {
  const jstMs = now.getTime() + (now.getTimezoneOffset() + 540) * 60000;
  const jst = new Date(jstMs);
  if (jst.getHours() < 5) jst.setDate(jst.getDate() - 1);
  return `${jst.getFullYear()}-${String(jst.getMonth() + 1).padStart(2, '0')}-${String(jst.getDate()).padStart(2, '0')}`;
}

/**
 * activeEvents の失効判定・自動昇格。
 * 各タブの TTL:
 *   Teaser  → イベント開始時刻到達で key "teaser:N" → "N" に昇格（削除なし）
 *   開催中  → eventEndMs + 7日 / fallback: eventStartMs + 14日 で削除
 *   Ending  → periodEndMs 到達で即削除
 *   開催終了 → eventEndMs + 7日 で削除（上記 開催中 と共通ロジック）
 *   全期限不明 → lastSeenAt + 30日 で削除
 */
function pruneExpiredActiveEvents() {
  const now = Date.now();
  const DAY           = 24 * 60 * 60 * 1000;
  const ACTIVE_TTL    = 14 * DAY;
  const ENDED_TTL     =  7 * DAY;
  const STALE_TTL     = 30 * DAY;
  let changed = false;
  for (const k of Object.keys(activeEvents)) {
    const e = activeEvents[k];

    // 1. Teaser: 開始時刻到達 → key を "teaser:N" から "N" に変えて開催中エントリへ昇格
    if (e.isTeaser) {
      if (Number.isFinite(e.periodEndMs) && e.periodEndMs <= now) {
        const title  = String(e.title || '').trim();
        // 既に同一タイトルの本開催エントリがあれば teaser は重複なので削除のみ（昇格しない）
        const dupActive = title && Object.keys(activeEvents).some(ek =>
          ek !== k && !activeEvents[ek].isTeaser &&
          String(activeEvents[ek].title || '').trim() === title);
        const numId  = e.hash?.match(/^#teaser\/(\d+)/)?.[1];
        const newKey = numId || k;
        delete activeEvents[k];
        // 昇格エントリは promotedFromTeaser を立てておき、後で本開催 (#event/...) を
        // 検出した際にタイトル一致で本物の hash へ置換できるようにする。
        // hash は本開催 URL を捏造せず、元の teaser hash (#teaser/N) を保持する。
        //   teaser ID と本開催 event hash には法則性が無く (例: teaser 1172 ⇔ event
        //   treasureraid172)、teaser ID から本開催 URL を導出できないため。
        //   本開催ページ訪問時に EVENT_INFO_DETECTED のタイトル統合で本物 hash へ修復される。
        if (!dupActive && !activeEvents[newKey]) {
          activeEvents[newKey] = {
            ...e,
            isTeaser:           false,
            promotedFromTeaser: true,
            periodEndMs: Number.isFinite(e.eventEndMs) ? e.eventEndMs : null,
            hash:        e.hash,
            eventName:   newKey,
          };
        }
        changed = true;
      }
      // Teaser には TTL なし（切替前タブが存在しないため）
      continue;
    }

    // 2. Ending: エンディング期間終了で即削除
    if (e.isEnding) {
      if (Number.isFinite(e.periodEndMs) && e.periodEndMs <= now) {
        delete activeEvents[k];
        changed = true;
      }
      continue;
    }

    // 2.5. Reward 受け取り期間中: 期間終了で即削除（+7日 TTL なし）。
    // GBF 側のページ自体が消えるため、それ以上保持する意味がない。
    if (e.isRewardClaim) {
      const rewardEnd = Number.isFinite(e.eventEndMs) ? e.eventEndMs : e.periodEndMs;
      if (Number.isFinite(rewardEnd) && rewardEnd <= now) {
        delete activeEvents[k];
        changed = true;
      }
      continue;
    }

    // 3. Active / 開催終了: eventEndMs を主キーに TTL 管理
    const endMs = Number.isFinite(e.eventEndMs) ? e.eventEndMs
                : Number.isFinite(e.periodEndMs) ? e.periodEndMs
                : null;

    if (Number.isFinite(endMs)) {
      // eventEndMs + 7日 で削除（開催終了タブの保持期間）
      if (now > endMs + ENDED_TTL) {
        delete activeEvents[k];
        changed = true;
      }
      continue;
    }

    // 3.5. 終了マーカーあり・終了時刻不明: 最終観測 + 7日 で削除（開催中 fallback に流さない）
    if (e.isEventEnd) {
      if (!Number.isFinite(e.lastSeenAt) || now > e.lastSeenAt + ENDED_TTL) {
        delete activeEvents[k];
        changed = true;
      }
      continue;
    }

    // 4. eventEndMs 不明、eventStartMs あり: eventStartMs + 14日 fallback
    if (Number.isFinite(e.eventStartMs)) {
      if (now > e.eventStartMs + ACTIVE_TTL) {
        delete activeEvents[k];
        changed = true;
      }
      continue;
    }

    // 5. 全期限不明: lastSeenAt + 30日 スタール削除
    if (!Number.isFinite(e.lastSeenAt) || now - e.lastSeenAt > STALE_TTL) {
      delete activeEvents[k];
      changed = true;
    }
  }
  return changed;
}

/** カテゴリフィルタが ALL もしくは event を含むときだけ、(イベント) バナーを表示する */
function shouldShowEventBanner() {
  const cats = getHostCategoryFilters();
  return cats.includes('all') || cats.includes('event');
}

/** イベントカテゴリのマイクエスト履歴を、イベント終了に同期して履歴から除去する。
 *  優先順:
 *   1. eventPeriodEndMs が有限 → now がそれを過ぎていれば削除。
 *   2. eventName が紐付いていて、その eventName が activeEvents に存在しない
 *      (= 観測中の開催中／予告イベントには無い) → 終了済みと見なし削除。
 *      activeEvents には eventEndMs + 7 日まで残るため、その間は誤削除しない。
 *   3. どちらの情報も持たないレガシーエントリは、lastTimestamp が現在より
 *      EVENT_STALE_MS (21 日) 以上前なら削除。GBF の通常イベント尺
 *      (1-2 週間、エンディング期間込みでも 3 週間以内) を超えるものは
 *      終了済みと判断して問題ない。
 */
function pruneExpiredEventAdventHosts() {
  const now = Date.now();
  const EVENT_STALE_MS = 21 * 24 * 60 * 60 * 1000;
  const catOf = (r) => r.raidCategory || questMeta[r.questId]?.raidCategory || 'etc';

  const next = hostHistory.filter((r) => {
    if (catOf(r) !== 'event') return true;

    // (1) 期限既知 → 過ぎていれば削除
    const end = r.eventPeriodEndMs;
    if (Number.isFinite(end)) return now < end;

    // (2) eventName 紐付き → 対応 activeEvents が無ければ終了済み扱い
    if (typeof r.eventName === 'string' && r.eventName) {
      if (!activeEvents[r.eventName]) return false;
      return true;
    }

    // (3) 情報なしレガシー → lastTimestamp ベースの stale 判定
    if (Number.isFinite(r.lastTimestamp) && r.lastTimestamp > 0
        && (now - r.lastTimestamp) > EVENT_STALE_MS) {
      return false;
    }
    return true;
  });
  if (next.length === hostHistory.length) return false;
  hostHistory = next;
  return true;
}

/** raidCategory === 'etc' のうち lastTimestamp が 2 日以上前のものを削除 */
function pruneStaleEtcHosts() {
  const STALE_MS = 2 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const catOf = (r) => r.raidCategory || questMeta[r.questId]?.raidCategory || 'etc';

  const next = hostHistory.filter((r) => {
    if (catOf(r) !== 'etc') return true;
    if (!Number.isFinite(r.lastTimestamp) || r.lastTimestamp <= 0) return true;
    return now - r.lastTimestamp <= STALE_MS;
  });
  if (next.length === hostHistory.length) return false;
  hostHistory = next;
  return true;
}

// ── マイクエスト Storage ──────────────────────────────────
// 旧形式(自発1件=1レコード)を新形式(questId=1エントリ)に集約
function migrateHostHistoryIfNeeded(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  // 既に新形式ならそのまま返す（先頭エントリで判定）
  if (raw[0] && 'todayCount' in raw[0]) return raw;
  const map = new Map();
  for (const r of raw) {
    if (!r || !r.questId) continue;
    const cur = map.get(r.questId) || {
      questId:       r.questId,
      questType:     r.questType,
      treasureId:    r.treasureId || '',
      lastTimestamp: 0,
      todayCount:    0,
      raidCategory:  r.raidCategory || 'etc',
    };
    cur.todayCount    += 1;
    cur.lastTimestamp  = Math.max(cur.lastTimestamp, r.timestamp || 0);
    cur.questType      = r.questType || cur.questType;
    cur.treasureId     = r.treasureId || cur.treasureId;
    cur.raidCategory   = r.raidCategory || cur.raidCategory;
    map.set(r.questId, cur);
  }
  return [...map.values()];
}

async function loadHostHistory() {
  return new Promise(resolve => {
    chrome.storage.local.get(['gbfRfHostHistory', 'gbfRfQuestMeta', 'gbfRfHostHistoryDate', 'gbfRfEnemyImgCache', 'gbfRfActiveEvents', 'gbfRfEventBanners', 'gbfRfDropEvents', 'gbfRfDropWatch', 'gbfRfDropWatchArchive', 'gbfRfSeenResultKeys'], data => {
      // ドロップ取得イベント（時系列）と ウォッチリスト
      dropEvents     = Array.isArray(data.gbfRfDropEvents)
        ? data.gbfRfDropEvents.filter(e => e && typeof e === 'object' && e.watchId)
        : [];
      dropWatchArchive = Array.isArray(data.gbfRfDropWatchArchive)
        ? data.gbfRfDropWatchArchive.filter(a => a && typeof a === 'object' && a.id)
        : [];
      seenResultKeys = (data.gbfRfSeenResultKeys && typeof data.gbfRfSeenResultKeys === 'object') ? data.gbfRfSeenResultKeys : {};

      // TTL + 件数上限でトリム。差分があれば書き戻す。
      if (pruneDropEvents()) chrome.storage.local.set({ gbfRfDropEvents: dropEvents });
      if (pruneDropWatchArchive()) saveDropWatchArchive();

      // 旧 gbfRfDropLog（累計合算形式）は廃止 → 1 回だけ掃除
      chrome.storage.local.remove('gbfRfDropLog');

      // ウォッチリストの形式チェック・マイグレーション
      const rawWatch = Array.isArray(data.gbfRfDropWatch) ? data.gbfRfDropWatch : null;
      // 旧形式（patterns/itemIds/labelKey/enabled を持つ）を検出したら全置換し dropEvents もリセット
      const isLegacyFormat = rawWatch && rawWatch.some(w =>
        w && (Array.isArray(w.patterns) || Array.isArray(w.itemIds) || 'labelKey' in w || 'enabled' in w)
      );
      if (!rawWatch || isLegacyFormat) {
        dropWatch = DEFAULT_DROP_WATCH.map(w => ({ ...w, addedAt: Date.now() }));
        dropEvents = [];
        dropWatchArchive = [];
        chrome.storage.local.set({ gbfRfDropWatch: dropWatch, gbfRfDropEvents: dropEvents, gbfRfDropWatchArchive: dropWatchArchive });
      } else {
        dropWatch = rawWatch;
      }

      // 古い seenResultKeys を掃除
      const cutoff = Date.now() - SEEN_RESULT_TTL_MS;
      let prunedKeys = false;
      for (const k of Object.keys(seenResultKeys)) {
        if (!Number.isFinite(seenResultKeys[k]) || seenResultKeys[k] < cutoff) {
          delete seenResultKeys[k];
          prunedKeys = true;
        }
      }
      if (prunedKeys) chrome.storage.local.set({ gbfRfSeenResultKeys: seenResultKeys });
      hostHistory     = migrateHostHistoryIfNeeded(data.gbfRfHostHistory || []);
      questMeta       = data.gbfRfQuestMeta       || {};
      hostHistoryDate = data.gbfRfHostHistoryDate  || '';
      activeEvents    = (data.gbfRfActiveEvents && typeof data.gbfRfActiveEvents === 'object') ? data.gbfRfActiveEvents : {};
      eventBanners    = (data.gbfRfEventBanners && typeof data.gbfRfEventBanners === 'object') ? data.gbfRfEventBanners : {};
      // 後方互換: 旧形式（isTeaser フィールド未保存）の救済。eventName が teaser:NNN なら teaser として扱う。
      for (const e of Object.values(activeEvents)) {
        if (e && typeof e === 'object' && e.isTeaser === undefined) {
          e.isTeaser = typeof e.eventName === 'string' && e.eventName.startsWith('teaser:');
        }
        if (e && typeof e === 'object' && e.isEnding === undefined) {
          e.isEnding = false;
        }
        if (e && typeof e === 'object' && e.isEventEnd === undefined) {
          e.isEventEnd = false;
        }
      }
      // キャッシュ済み敵画像をquestMetaにマージ
      const imgCache = data.gbfRfEnemyImgCache || {};
      for (const [qid, src] of Object.entries(imgCache)) {
        if (!questMeta[qid]) questMeta[qid] = {};
        if (!questMeta[qid].enemyImgSrc && src) {
          questMeta[qid].enemyImgSrc = src;
        }
      }
      checkDailyReset();
      let dirty = false;
      if (pruneExpiredEventAdventHosts()) dirty = true;
      if (pruneExpiredActiveEvents())     dirty = true;
      if (pruneExpiredEventBanners())     dirty = true;
      if (pruneStaleEtcHosts())           dirty = true;
      // 既存ストレージの hell カウンタを dataid 単位に揃える（min 採用）
      if (migrateHellSharedLimited())     dirty = true;
      if (dirty) saveHostHistory();
      resolve();
    });
  });
}

// ── Hell 回数の dataid 共有 ─────────────────────────
// GBF 仕様で同一カテゴリ hell（例: Lv60 / Lv90）は回数を共有する。
// questId は `hell_<dataId>_<dataGroup>_<questIdNumeric>` 形式でレベル別カードを
// 保持するため、回数（limitedCount / maxLimitedCount）だけを dataid 単位で sibling
// 間に伝播させる。
function getHellDataidKey(questId) {
  if (typeof questId !== 'string' || !questId.startsWith('hell_')) return null;
  const parts = questId.split('_');
  // 新形式: hell_<id>_<group>_<numeric> → hell_<id>_<group>
  // 旧形式: hell_<id>_<group> → そのまま
  if (parts.length <= 3) return questId;
  return parts.slice(0, 3).join('_');
}

function syncHellLimitedAcrossSiblings(questId) {
  const key = getHellDataidKey(questId);
  if (!key) return;
  const src = questMeta[questId];
  if (!src) return;
  const limited = src.limitedCount;
  const max     = src.maxLimitedCount;
  for (const qid in questMeta) {
    if (qid === questId) continue;
    if (getHellDataidKey(qid) !== key) continue;
    const sib = questMeta[qid];
    if (!sib || !sib.isHellQuest) continue;
    // 共有プール前提なので「より少なく観測された側が真値」として min 採用。
    // migrateHellSharedLimited（起動時）と同じ保守的選択でランタイム伝播も揃える。
    // 兄弟側が未観測 (非有限) なら src 側を初期値として採用。
    if (Number.isFinite(limited)) {
      sib.limitedCount = Number.isFinite(sib.limitedCount)
        ? Math.min(sib.limitedCount, limited)
        : limited;
    }
    if (Number.isFinite(max)) {
      sib.maxLimitedCount = Number.isFinite(sib.maxLimitedCount)
        ? Math.min(sib.maxLimitedCount, max)
        : max;
    }
  }
}

// 起動時の既存ストレージマイグレーション。
// 同一 dataidKey の全 hell エントリで limitedCount / maxLimitedCount を min に揃える
// （実際の回数共有として安全な保守的選択）。
function migrateHellSharedLimited() {
  const groups = new Map(); // key → { limited: number|undefined, max: number|undefined }
  for (const qid in questMeta) {
    const m = questMeta[qid];
    if (!m || !m.isHellQuest) continue;
    const key = getHellDataidKey(qid);
    if (!key) continue;
    const g = groups.get(key) || { limited: undefined, max: undefined };
    if (Number.isFinite(m.limitedCount)) {
      g.limited = (g.limited === undefined) ? m.limitedCount : Math.min(g.limited, m.limitedCount);
    }
    if (Number.isFinite(m.maxLimitedCount)) {
      g.max = (g.max === undefined) ? m.maxLimitedCount : Math.min(g.max, m.maxLimitedCount);
    }
    groups.set(key, g);
  }
  let dirty = false;
  for (const qid in questMeta) {
    const m = questMeta[qid];
    if (!m || !m.isHellQuest) continue;
    const key = getHellDataidKey(qid);
    const g = groups.get(key);
    if (!g) continue;
    if (Number.isFinite(g.limited) && m.limitedCount !== g.limited) { m.limitedCount = g.limited; dirty = true; }
    if (Number.isFinite(g.max)     && m.maxLimitedCount !== g.max) { m.maxLimitedCount = g.max; dirty = true; }
  }
  return dirty;
}

// maxLimitedCount が取得できないクエスト向けの最終フォールバック。
// limitedCount > 0 のみで max 相当が DOM から得られない場合、その limitedCount を max として固定採用する。
// 既に max が有限値で入っている場合は no-op（真値を上書きしない）。
function applyMaxLimitedCountFallback(meta) {
  if (!meta) return;
  if (Number.isFinite(meta.maxLimitedCount) && meta.maxLimitedCount > 0) return;
  if (Number.isFinite(meta.limitedCount) && meta.limitedCount > 0) {
    meta.maxLimitedCount = meta.limitedCount;
  }
}

function saveHostHistory() {
  chrome.storage.local.set({
    gbfRfHostHistory:     hostHistory,
    gbfRfQuestMeta:       questMeta,
    gbfRfHostHistoryDate: hostHistoryDate,
    gbfRfActiveEvents:    activeEvents,
    gbfRfEventBanners:    eventBanners,
  });
}

function checkDailyReset() {
  const today = getGBFDateString();
  if (hostHistoryDate !== today) {
    // 前日の実自発回数（todayCount）は questMeta 側に無いので、ゼロクリア前に引く
    const usedByQuest = new Map();
    for (const r of hostHistory) usedByQuest.set(String(r.questId), r.todayCount || 0);

    for (const qid in questMeta) {
      const m = questMeta[qid];
      // Hell クエストは日付変更で初期化されない（クリア時に確率で増えるのみ）。
      // 回数の増減要因もキャンペーン／パスとは無関係なので学習・解除の対象外。
      if (m.isHellQuest) continue;
      const isPro = m.raidCategory === 'pro';

      // ── MAX 学習 ──
      // 上限解除して余分に自発できた日は、その実績が真の上限なので learnedMax に採用。
      // 未消化だった日は実績が上限を示さないため learnedMax を捨てて baseMax へ戻す。
      // これによりキャンペーン／パスが切れても翌日以降に自動収束し、手動解除が最小で済む。
      const used    = usedByQuest.get(String(qid)) || 0;
      const prevEff = effectiveMax(m, isPro);
      if (used > 0 && Number.isFinite(prevEff) && used >= prevEff) m.learnedMax = used;
      else delete m.learnedMax;

      // 本日分の上限解除は日付をまたいだ時点で失効
      delete m.overrideDate;

      // 残り回数を実効 MAX（学習後）に戻す。
      // 学習値は「そのクエストで実際に使われるカウンタ」にだけ乗せ、
      // もう一方は従来どおり DOM 真値へ戻す。
      const eff = effectiveMax(m, isPro);
      if (isPro) {
        if (eff != null)               m.proQuestSkip = eff;
        if (m.maxLimitedCount != null) m.limitedCount = m.maxLimitedCount;
      } else {
        if (eff != null)               m.limitedCount = eff;
        if (m.maxProQuestSkip != null) m.proQuestSkip = m.maxProQuestSkip;
      }
    }

    // パネル（クエスト一覧）は保持し、本日の回数だけリセット
    hostHistory.forEach(r => { r.todayCount = 0; });
    hostHistoryDate = today;
    // 日付変更時に敵画像キャッシュもクリア（ストレージ肥大化防止）
    chrome.storage.local.remove('gbfRfEnemyImgCache');
  }
}

// ── タブ切替（アイコンバー） ─────────────────────────
function switchTab(tab) {
  if (tab === activeTab) return;
  activeTab = tab;
  elIconBar.querySelectorAll('.icon-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab)
  );
  document.body.classList.remove('tab-dashboard', 'tab-rescue', 'tab-host-history', 'tab-info');
  document.body.classList.add(`tab-${tab}`);
  if (tab === 'rescue') {
    load(false);
  } else if (tab === 'host-history') {
    // 救援タブで付与された bp-locked クラスは #list を共有するマイクエストにも効くため
    // タブ離脱時に解除する。救援に戻る際は load() → evaluateBpLock() で再判定される。
    unlockPanel();
    renderHostHistory();
  } else if (tab === 'dashboard') {
    unlockPanel();
    renderDashboard();
  } else {
    unlockPanel();
  }
  // info タブは静的コンテンツのみのため再描画不要
}

// host/event データ更新時に、現在表示中のビュー（マイクエスト or ダッシュボード）を再描画する。
// イベントバナーはダッシュボードへ移設済みのため、両ビューを一括ハンドリングする。
function refreshHostViews() {
  if (activeTab === 'host-history') renderHostHistory();
  else if (activeTab === 'dashboard') renderDashboard();
}

// ── カテゴリ共通ヘルパ（マイクエスト / ダッシュボードで共用） ──
const CAT_ORDER = ['event', 'pro', 'nm', 'hl', 'ul', 'free', 'etc'];
function catLabel(cat) {
  switch (cat) {
    case 'event': return t('catLabelEvent');
    case 'pro':   return 'PRO';
    case 'nm':    return 'NORMAL';
    case 'hl':    return 'HIGH LEVEL';
    case 'ul':    return 'UNLIMITED';
    case 'free':  return t('catLabelFree');
    default:      return t('catLabelOther');
  }
}
// rec.raidCategory → questMeta → 'etc' の優先でカテゴリ解決
function resolveCat(rec) {
  return rec.raidCategory || questMeta[rec.questId]?.raidCategory || 'etc';
}

// ── 実効 MAX / 本日上限解除 ────────────────────────────
// キャンペーンやプレミアムパスによる自発回数の増減は DOM から取得できない
// （マイクエスト経由で自発するとクエスト一覧ページを開かないため）。
// そのため baseMax（DOM 真値）に対し、前日の実績から学習した learnedMax を
// 上乗せした値を「実効 MAX」として表示・depleted 判定・日付リセットで共用する。
function effectiveMax(meta, isPro) {
  const base    = isPro ? meta?.maxProQuestSkip : meta?.maxLimitedCount;
  const learned = meta?.learnedMax;
  if (!Number.isFinite(learned)) return base;
  return Number.isFinite(base) ? Math.max(learned, base) : learned;
}

// 本日分の上限判定が手動解除されているか（GBF 日付が変わると自動失効）
function isOverridden(meta) {
  return !!meta && meta.overrideDate === hostHistoryDate;
}

// 本日上限解除トグルの ON/OFF 表示。現在のカテゴリフィルタ対象に解除中エントリがあれば ON。
function updateOverrideBtnState() {
  if (!btnDepletedOverride) return;
  const on = hostHistory.some(rec =>
    passesCategoryFilter(rec) && isOverridden(questMeta[rec.questId])
  );
  btnDepletedOverride.classList.toggle('active', on);
}

// 1エントリが depleted（残り自発回数 0）かを判定。PRO は proQuestSkip、それ以外は limitedCount。
// Hell は max 常に n1 と同値仕様 (0/0 を許容) のため、max>0 ガードを外し remaining===0 で判定する。
// マイクエストの描画と本日上限解除トグルの両方から使うためモジュールスコープに置く。
function isHostEntryDepleted(rec) {
  const meta = questMeta[rec.questId] || null;
  if (!meta) return false;
  const isPro = resolveCat(rec) === 'pro';
  if (meta.isHellQuest) {
    return Number.isFinite(meta.limitedCount) && meta.limitedCount <= 0;
  }
  // 本日分の上限解除中は灰色にしない（キャンペーン／パスによる増加分を手動で解放）
  if (isOverridden(meta)) return false;
  const max       = effectiveMax(meta, isPro);
  const remaining = isPro ? meta.proQuestSkip : meta.limitedCount;
  const hasLimit  = typeof max === 'number' && max > 0;
  return hasLimit && typeof remaining === 'number' && remaining <= 0;
}

// ── マイクエスト カテゴリフィルタ判定 ──────────────────
function passesCategoryFilter(rec) {
  const cats = getHostCategoryFilters();
  if (cats.includes('all')) return true;
  const c = rec.raidCategory || questMeta[rec.questId]?.raidCategory || 'etc';
  return cats.includes(c);
}

// ── カテゴリチップのクリアバッジ（全自発済み）更新 ─────
function updateCategoryChipBadges(categoryClearState) {
  if (!elHostCategoryBar) return;
  elHostCategoryBar.querySelectorAll('.cat-chip').forEach(chip => {
    const cat = chip.dataset.cat;
    const isCleared = cat !== 'all' && !!categoryClearState?.[cat];
    chip.classList.toggle('cleared', isCleared);
  });
}

// ── 開催中／予告イベント バナー HTML 生成 ──────────────
// mypage グローバルバナー由来の eventBanners を画像で描画する。
// 「ALL もしくは event カテゴリ選択中」のときだけ非空 HTML を返す。
// 群分け: isTeaser→開催前 / isEventEnd または eventEndMs<=now→開催終了（グレーアウト）/ それ以外→開催中。
function buildActiveEventsBannerHTML() {
  if (!settings.showEventBanner) return '';
  if (!shouldShowEventBanner()) return '';
  const now = Date.now();

  const teasers = [];
  const actives = [];
  const ended   = [];
  for (const b of Object.values(eventBanners)) {
    if (!b || !b.bannerSrc) continue;
    if (b.isTeaser) {
      teasers.push(b);
    } else if (b.isEventEnd || (Number.isFinite(b.eventEndMs) && b.eventEndMs <= now)) {
      ended.push(b);
    } else {
      actives.push(b);
    }
  }
  if (teasers.length + actives.length + ended.length === 0) return '';

  // teaser / active は終了が近い順、ended は終了が新しい順（期間未取得は末尾）
  teasers.sort((a, b) => (a.eventEndMs ?? Infinity) - (b.eventEndMs ?? Infinity));
  actives.sort((a, b) => (a.eventEndMs ?? Infinity) - (b.eventEndMs ?? Infinity));
  ended.sort((a, b)   => (b.eventEndMs ?? 0)        - (a.eventEndMs ?? 0));

  const bannerHTML = (b) => {
    const period = b.periodText
      ? `<span class="event-banner-period">${esc(b.periodText)}</span>` : '';
    return `
    <div class="event-banner" data-path="${esc(b.path)}" data-hash="${esc(b.hash || '')}">
      <img class="event-banner-img" src="${esc(b.bannerSrc)}" alt="">
      ${period}
      <button class="event-banner-del" data-path="${esc(b.path)}" title="${esc(t('eventBannerDelTitle'))}">×</button>
    </div>`;
  };

  const groupHTML = (cls, labelKey, list) => list.length === 0 ? '' : `
    <div class="event-group ${cls}">
      <span class="event-group-label">${esc(t(labelKey))}</span>
      <div class="event-group-banners">${list.map(bannerHTML).join('')}</div>
    </div>`;

  return `<div class="active-events">${
    groupHTML('event-group-teaser', 'eventGroupTeaser', teasers)
  }${
    groupHTML('event-group-active', 'eventGroupActive', actives)
  }${
    groupHTML('event-group-ended',  'eventGroupEnded',  ended)
  }</div>`;
}

// ── 7日未観測のバナー（base64 キャッシュ含む）を削除 ──
function pruneExpiredEventBanners() {
  const now = Date.now();
  const TTL = 7 * 24 * 60 * 60 * 1000;
  let changed = false;
  for (const k of Object.keys(eventBanners)) {
    const b = eventBanners[k];
    if (!b || !Number.isFinite(b.lastSeenAt) || (now - b.lastSeenAt) > TTL) {
      delete eventBanners[k];
      changed = true;
      continue;
    }
    // Teaser バナーは開催開始時刻に到達したら削除（本開催バナーは mypage 巡回で別途生成される）
    if (b.isTeaser && Number.isFinite(b.eventStartMs) && b.eventStartMs <= now) {
      delete eventBanners[k];
      changed = true;
    }
  }
  return changed;
}

// ── マイクエスト レンダリング ──────────────────────────
function renderHostHistory() {
  checkDailyReset();
  let dirty = false;
  if (pruneExpiredEventAdventHosts()) dirty = true;
  if (pruneExpiredActiveEvents())     dirty = true;
  if (pruneExpiredEventBanners())     dirty = true;
  if (dirty) saveHostHistory();
  elHostDate.textContent = hostHistoryDate;
  updateOverrideBtnState();

  // resolveCat / CAT_ORDER / catLabel / isHostEntryDepleted はモジュール先頭の共通ヘルパを使用
  const isEntryDepleted = isHostEntryDepleted;

  // カテゴリごとに「登録あり & 全て depleted」＝クリア状態を判定。
  // 判定は現在のカテゴリフィルタに関係なく hostHistory 全件で行う。
  const categoryClearState = {};
  for (const cat of CAT_ORDER) {
    const inCat = hostHistory.filter(rec => resolveCat(rec) === cat);
    categoryClearState[cat] = inCat.length > 0 && inCat.every(isEntryDepleted);
  }
  updateCategoryChipBadges(categoryClearState);

  // 新形式: hostHistory は questId ごとに 1 エントリ。そのまま絞り込み→ソート
  const entries = hostHistory
    .filter(rec => passesCategoryFilter(rec))
    .filter(rec => !settings.hideDepleted || !isEntryDepleted(rec))
    .map(rec => ({
      questId:       rec.questId,
      questType:     rec.questType,
      treasureId:    rec.treasureId,
      todayCount:    rec.todayCount || 0,
      lastTimestamp: rec.lastTimestamp || 0,
      raidCategory:  resolveCat(rec),
      meta:          questMeta[rec.questId] || null,
    }))
    .sort((a, b) => b.lastTimestamp - a.lastTimestamp);

  if (entries.length === 0) {
    const msg = hostHistory.length === 0
      ? t('hostNoQuests')
      : t('hostNoCatQuests');
    setListHTML(`<div class="state"><div class="ico">📋</div><p>${msg}</p></div>`);
    return;
  }

  const renderTile = (entry) => {
    const meta     = entry.meta;
    const name     = meta?.chapterName || `Quest ${entry.questId}`;
    const isPro    = entry.raidCategory === 'pro';
    const max      = meta?.isHellQuest ? meta?.maxLimitedCount : effectiveMax(meta, isPro);
    const remaining = isPro ? meta?.proQuestSkip    : meta?.limitedCount;
    const isDepleted = isEntryDepleted({ questId: entry.questId, raidCategory: entry.raidCategory });
    const tileClass  = isDepleted ? ' depleted' : '';
    const badgeClass = isDepleted ? ' depleted' : '';

    const lastTime = entry.lastTimestamp ? new Date(entry.lastTimestamp) : null;
    const timeStr  = lastTime ? `${lastTime.getHours()}:${pad(lastTime.getMinutes())}` : '';

    // 画像ソース優先順位:
    //   グループA: パネル/サポ石画像（ユーザー自身の操作で発火する DOM 由来）
    //     - questThumbnailSrc : extractQuestMeta() がパネル DOM から抽出（multi/free/extra/free quest-list 各形式対応）
    //     - hostThumbnailSrc  : サポート召喚石選択画面の .prt-quest-thumb
    //   グループB: バトル画像（/enemy_*.js キャッシュ、background.js）
    //     - enemyImgSrc       : バトル開始時に取得・キャッシュ（event 自発はここに落ちる）
    //   どれも無ければプレースホルダー。
    //   ※ 救援レイド一覧由来の thumbnailSrc は意図的に不採用。
    //      取得が他人のホスト状況に依存し不安定で、一度キャッシュされるとバトル画像より優先されてしまう問題があった。
    const thumbSrc =
      // --- グループA: パネル/サポ石画像 ---
      meta?.questThumbnailSrc ||
      meta?.hostThumbnailSrc ||
      // --- グループB: バトル画像 ---
      meta?.enemyImgSrc ||
      '';
    const thumbHtml = thumbSrc
      ? `<img class="thumb" src="${esc(thumbSrc)}" alt="" loading="lazy">`
      : `<div class="thumb-placeholder">⚔</div>`;

    // Hell は max 常に n1 と同値仕様 (0/0 を許容) のため > 0 ガードを外す。
    // 非 hell は applyMaxLimitedCountFallback により max が undefined か >=1 のみ → 既存挙動と整合。
    // 上限解除中は残り回数が実態とズレているため「残り n/m」を出さず、
    // 本日の実自発回数（＝翌日の MAX 学習に使われる値）だけを見せる。
    const limitInfo = isOverridden(meta)
      ? `<span class="host-count-badge override"><span class="hc-badge-mark">${esc(t('hostOverrideBadge'))}</span><span class="hc-current">${entry.todayCount}</span>${esc(t('hostTodayCountSuffix'))}</span>`
      : (Number.isFinite(max) && Number.isFinite(remaining))
        ? `<span class="host-count-badge${badgeClass}">${esc(t('hostRemainingPre'))}<span class="hc-current">${remaining}</span><span class="hc-sep">/</span><span class="hc-max">${max}</span>${esc(t('hostRemainingPost'))}</span>`
        : `<span class="host-count-badge"><span class="hc-current">${entry.todayCount}</span>${esc(t('hostTodayCountSuffix'))}</span>`;

    // hell skip プルダウン: hellSkipParams が観測されており、残り回数 > 0 の hell タイルに表示。
    // 上限は min(残り回数, 10)。初期選択値は常に最大（=末尾の option）。
    const isHell = !!meta?.isHellQuest;
    const hasSkipParams = isHell && !!meta?.hellSkipParams?.questIdNumeric;
    const remainingForSkip = Number.isFinite(remaining) ? remaining : 0;
    const skipMax = hasSkipParams ? Math.min(remainingForSkip, 10) : 0;
    const skipDropdownHtml = (skipMax > 0)
      ? buildHellSkipDropdownHtml(skipMax)
      : '';

    const cat = entry.raidCategory || 'etc';
    return `
<div class="host-tile host-cat-${esc(cat)}${tileClass}" data-quest-id="${esc(entry.questId)}" data-quest-type="${esc(entry.questType)}" data-treasure-id="${esc(entry.treasureId)}" data-category="${esc(cat)}">
  <button type="button" class="host-tile-open" aria-label="${esc(name)}"></button>
  ${thumbHtml}
  <button class="host-del" data-quest-id="${esc(entry.questId)}" title="削除">✕</button>
  <div class="host-tile-info">
    <div class="host-tile-name">${esc(name)}</div>
    <div class="host-tile-meta">${limitInfo}${skipDropdownHtml} <span class="host-tile-time">${timeStr}</span></div>
  </div>
</div>`;
  };

  // カテゴリ単位でグルーピング → 定義順にセクション描画（空カテゴリ & 全自発済みカテゴリはスキップ）
  // hideDepleted=OFF の場合は全自発済みカテゴリも表示する
  // （イベント告知バナーはダッシュボードへ移設済み）
  const sections = CAT_ORDER.map(cat => {
    if (settings.hideDepleted && categoryClearState[cat]) return '';
    const group = entries.filter(e => (e.raidCategory || 'etc') === cat);
    if (group.length === 0) return '';
    const header = `<div class="host-group-header host-cat-${esc(cat)}"><span class="host-group-label">(${esc(catLabel(cat))})</span><span class="host-group-line"></span></div>`;
    const grid = `<div class="host-grid">${group.map(renderTile).join('')}</div>`;
    return `<div class="host-group">${header}${grid}</div>`;
  }).join('');

  setListHTML(`<div class="host-groups">${sections}</div>`);

  // タイルクリックで自発遷移
  elList.querySelectorAll('.host-tile').forEach(tile => {
    tile.addEventListener('click', (e) => {
      if (e.target.closest('.host-del')) return;
      // skip プルダウン上のクリックはタイル遷移を発火させない
      if (e.target.closest('.hell-skip-select')) return;
      if (tile.classList.contains('depleted')) return;
      const qid = tile.dataset.questId;
      // Hell: skip 観測済みなら直遷移、未観測なら従来通り #quest/extra
      if (questMeta[qid]?.isHellQuest) {
        const sel = tile.querySelector('.hell-skip-select');
        const skipCount = sel ? (parseInt(sel.value, 10) || null) : null;
        hostHellQuest(qid, skipCount);
        return;
      }
      hostQuest(tile, {
        questId:    qid,
        questType:  tile.dataset.questType,
        treasureId: tile.dataset.treasureId,
      });
    });
  });

  // skip プルダウンの click/change 単体ではタイル遷移を発火させない
  elList.querySelectorAll('.hell-skip-select').forEach(sel => {
    sel.addEventListener('click', (e) => e.stopPropagation());
    sel.addEventListener('change', (e) => e.stopPropagation());
  });

  // 個別削除
  elList.querySelectorAll('.host-del').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const qid = btn.dataset.questId;
      hostHistory = hostHistory.filter(r => r.questId !== qid);
      saveHostHistory();
      renderHostHistory();
    });
  });
}

// バナークリック → data-hash（= #+path）へ遷移。× で eventBanners から削除。
// root はバナーを内包する要素（ダッシュボード領域）。
function wireActiveEventClicks(root) {
  if (!root) return;
  root.querySelectorAll('.event-banner').forEach(card => {
    card.addEventListener('click', async (e) => {
      if (e.target.closest('.event-banner-del')) return; // × は別ハンドラ
      const hash = card.dataset.hash || (card.dataset.path ? '#' + card.dataset.path : '');
      if (!hash) return;
      const tab = await getGBFTab();
      if (!tab) return;
      try {
        await chrome.tabs.update(tab.id, { url: `https://game.granbluefantasy.jp/${hash}`, active: true });
      } catch (err) {
        console.error('Event banner navigation error:', err);
      }
    });
  });
  root.querySelectorAll('.event-banner-del').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const path = btn.dataset.path;
      if (path) { delete eventBanners[path]; saveHostHistory(); renderDashboard(); }
    });
  });
}

// ── 今日の自発サマリー HTML 生成 ──────────────────────
// hostHistory を CAT_ORDER 順に集計し、本日合計 + カテゴリ別内訳を返す。
function buildHostSummaryHTML() {
  const counts = {};
  let total = 0;
  for (const rec of hostHistory) {
    const cat = resolveCat(rec);
    const c   = rec.todayCount || 0;
    counts[cat] = (counts[cat] || 0) + c;
    total += c;
  }
  const chips = CAT_ORDER
    .filter(cat => (counts[cat] || 0) > 0)
    .map(cat => `<span class="dash-sum-chip host-cat-${esc(cat)}"><span class="dash-sum-cat">${esc(catLabel(cat))}</span><span class="dash-sum-n">${counts[cat]}</span></span>`)
    .join('');
  return `
    <div class="dash-section dash-summary">
      <div class="dash-section-title">${esc(t('dashHostSummaryTitle'))}</div>
      <div class="dash-sum-total">${esc(t('dashHostTotalPre'))}<span class="dash-sum-total-n">${total}</span>${esc(t('dashHostTotalPost'))}</div>
      <div class="dash-sum-chips">${chips || `<span class="dash-sum-empty">${esc(t('dashHostEmpty'))}</span>`}</div>
    </div>`;
}

// ── dropEvents の TTL / 件数トリム ─────────────────────
// 90 日より古いものを削除し、それでも 500 件超なら新しい順に切り詰める。
// dropEvents は新しいものが先頭。変更があったか boolean で返す。
function pruneDropEvents() {
  const cutoff = Date.now() - DROP_EVENTS_TTL_MS;
  const before = dropEvents.length;
  dropEvents = dropEvents.filter(e => e && Number.isFinite(e.at) && e.at >= cutoff);
  if (dropEvents.length > DROP_EVENTS_MAX) dropEvents = dropEvents.slice(0, DROP_EVENTS_MAX);
  return dropEvents.length !== before;
}

// ── watch archive の掃除 ─────────────────────────────
// dropEvents に watchId が 1 件も残っていないエントリを削除し、それでも上限超過なら
// removedAt の新しい順に切り詰める（iconCached の dataURL 滞留防止）。変更有無を boolean で返す。
function pruneDropWatchArchive() {
  if (dropWatchArchive.length === 0) return false;
  const before = dropWatchArchive.length;
  const liveIds = new Set();
  for (const e of dropEvents) if (e && e.watchId) liveIds.add(e.watchId);
  dropWatchArchive = dropWatchArchive.filter(a => a && a.id && liveIds.has(a.id));
  if (dropWatchArchive.length > DROP_WATCH_ARCHIVE_MAX) {
    dropWatchArchive.sort((a, b) => (b.removedAt || 0) - (a.removedAt || 0));
    dropWatchArchive = dropWatchArchive.slice(0, DROP_WATCH_ARCHIVE_MAX);
  }
  return dropWatchArchive.length !== before;
}

function saveDropWatchArchive() {
  chrome.storage.local.set({ gbfRfDropWatchArchive: dropWatchArchive });
}

// watch を dropWatch → dropWatchArchive の順で解決（どちらにも無ければ null）
function findWatchAny(watchId) {
  return dropWatch.find(x => x && x.id === watchId)
      || dropWatchArchive.find(x => x && x.id === watchId)
      || null;
}

// ローカル時刻の YYYY-MM-DD キー
function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

// ── ドロップカレンダーの表示モデル計算（HTML 生成と PNG 生成で共用） ──
// `calendarMonth` の月の 1 日含む週の月曜 〜 末日含む週の日曜までの範囲と、
// 日付キー -> Map<watchId, count> の集約を返す。
function computeDropCalendarModel() {
  const y = calendarMonth.year, m = calendarMonth.month;
  const firstOfMonth = new Date(y, m, 1);
  const lastOfMonth  = new Date(y, m + 1, 0);
  const dow0 = (firstOfMonth.getDay() + 6) % 7;   // 月=0..日=6
  const dowL = (lastOfMonth.getDay() + 6) % 7;
  const startDate = new Date(y, m, 1 - dow0);
  const endDate   = new Date(lastOfMonth); endDate.setDate(lastOfMonth.getDate() + (6 - dowL));
  const totalDays = Math.round((endDate - startDate) / 86400000) + 1;

  // 日付キー -> Map<watchId, count> に集約
  const byDay = new Map();
  for (const ev of dropEvents) {
    if (!ev || !Number.isFinite(ev.at) || !ev.watchId) continue;
    const d = new Date(ev.at);
    if (d < startDate || d > endDate) continue;
    const key = ymd(d);
    let perDay = byDay.get(key);
    if (!perDay) { perDay = new Map(); byDay.set(key, perDay); }
    perDay.set(ev.watchId, (perDay.get(ev.watchId) || 0) + ev.count);
  }

  return { y, m, startDate, endDate, totalDays, byDay, monthLabel: `${y}-${pad(m + 1)}` };
}

// ── ドロップカレンダー HTML 生成（月単位、月曜始まり、左右ナビ） ────
// 各セルは [icon]×N をその日に集約。土曜/日曜/今日/当月外でスタイル分岐。
function buildDropLogHTML() {
  const { y, m, startDate, totalDays, byDay, monthLabel } = computeDropCalendarModel();

  // 曜日ヘッダ（月曜始まり、土日に別色）
  const headKeys = ['weekdayMon','weekdayTue','weekdayWed','weekdayThu','weekdayFri','weekdaySat','weekdaySun'];
  const head = headKeys.map((k, i) => {
    const cls = i === 5 ? 'sat' : i === 6 ? 'sun' : '';
    return `<div class="${cls}">${esc(t(k))}</div>`;
  }).join('');

  // セル生成
  const now = new Date();
  const todayKey = ymd(now);
  const cells = [];
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(startDate); d.setDate(startDate.getDate() + i);
    const dow = (d.getDay() + 6) % 7;
    const cls = ['dash-drop-cell'];
    if (dow === 5) cls.push('sat');
    if (dow === 6) cls.push('sun');
    if (d.getMonth() !== m) cls.push('off');
    const key = ymd(d);
    if (key === todayKey) cls.push('today');

    let items = '';
    const perDay = byDay.get(key);
    if (perDay) {
      const parts = [];
      for (const [watchId, count] of perDay) {
        const w = findWatchAny(watchId);
        if (!w) continue;
        const iconSrc = w.iconCached || buildIconUrl(w.category, w.itemId);
        const label   = w.name || `${w.category}/${w.itemId}`;
        parts.push(
          `<span class="dash-drop-cell-item" title="${esc(label)}">` +
            `<img src="${esc(iconSrc)}" alt="" loading="lazy" decoding="async">` +
            `<span class="dash-drop-cell-item-count">×${count}</span>` +
          `</span>`);
      }
      items = parts.join('');
    }
    cells.push(
      `<div class="${cls.join(' ')}">` +
        `<span class="dash-drop-cell-date">${d.getDate()}</span>` +
        `<div class="dash-drop-cell-items">${items}</div>` +
      `</div>`);
  }

  // 月ナビ（>: 今月で disabled）
  const canNext = (y < now.getFullYear()) || (y === now.getFullYear() && m < now.getMonth());

  return `
    <div class="dash-section">
      <div class="dash-drop-cal-nav">
        <button class="dash-drop-cal-prev" type="button">‹</button>
        <span class="dash-drop-cal-mid">
          <span class="dash-drop-cal-month">${esc(monthLabel)}</span>
          <button class="dash-drop-cal-shot" type="button" title="${esc(t('dashDropShotTitle'))}"${calShotBusy ? ' disabled' : ''}>📷</button>
        </span>
        <button class="dash-drop-cal-next" type="button"${canNext ? '' : ' disabled'}>›</button>
      </div>
      <div class="dash-drop-cal-head">${head}</div>
      <div class="dash-drop-cal">${cells.join('')}</div>
    </div>`;
}

// ── ドロップカレンダーのスクショ生成（クリップボードへコピー） ────────
// 表示中の月を Canvas 2D に手描きし PNG 化して navigator.clipboard.write() でコピーする。
// アイコンは iconCached（base64 dataURL）のみ描画。CDN 直 URL は canvas を汚染して
// toBlob が失敗するため描かず、プレースホルダ（矩形 + ?）に落とす。
async function exportDropCalendarPNG() {
  const model = computeDropCalendarModel();

  // 月内に出現する watchId を解決し、iconCached をプリロード
  const iconMap = new Map();  // watchId -> { w, img: Image|null }
  for (const perDay of model.byDay.values()) {
    for (const wid of perDay.keys()) {
      if (iconMap.has(wid)) continue;
      const w = findWatchAny(wid);
      if (w) iconMap.set(wid, { w, img: null });
    }
  }
  await Promise.all([...iconMap.values()].map(async ent => {
    if (!ent.w.iconCached) return;
    try {
      const img = new Image();
      img.src = ent.w.iconCached;
      await img.decode();
      ent.img = img;
    } catch { /* decode 失敗はプレースホルダ */ }
  }));

  // レイアウト（論理 px、SCALE=2 固定でパネル幅・DPI に依らず同じ出力にする）
  const SCALE = 2;
  const PAD = 12, TITLE_H = 26, HEAD_H = 18, CELL_W = 100, CELL_H = 80, GAP = 3;
  const weeks = model.totalDays / 7;
  const W = PAD * 2 + CELL_W * 7 + GAP * 6;
  const H = PAD * 2 + TITLE_H + HEAD_H + weeks * CELL_H + (weeks - 1) * GAP;

  const cssVar = (name, fb) =>
    (getComputedStyle(document.documentElement).getPropertyValue(name) || '').trim() || fb;
  const C = {
    bg1: cssVar('--bg1', '#1b1e24'),
    bg2: cssVar('--bg2', '#242832'),
    tx0: cssVar('--tx0', '#e6e9ef'),
    tx2: cssVar('--tx2', '#8b93a3'),
    acc: cssVar('--acc', '#4da3ff'),
    sat: '#8aa8d8', sun: '#d88a8a',
    satBg: 'rgba(110, 140, 190, 0.15)', sunBg: 'rgba(190, 110, 110, 0.15)',
  };
  const family = getComputedStyle(document.body).fontFamily || 'sans-serif';

  const canvas = document.createElement('canvas');
  canvas.width  = W * SCALE;
  canvas.height = H * SCALE;
  const ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = C.bg1;
  ctx.fillRect(0, 0, W, H);

  // 月ラベル
  ctx.fillStyle = C.tx0;
  ctx.font = `bold 16px ${family}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(model.monthLabel, W / 2, PAD + TITLE_H / 2);

  // 曜日ヘッダ（土日に別色）
  const headKeys = ['weekdayMon','weekdayTue','weekdayWed','weekdayThu','weekdayFri','weekdaySat','weekdaySun'];
  ctx.font = `12px ${family}`;
  for (let i = 0; i < 7; i++) {
    ctx.fillStyle = i === 5 ? C.sat : i === 6 ? C.sun : C.tx2;
    ctx.fillText(t(headKeys[i]), PAD + i * (CELL_W + GAP) + CELL_W / 2, PAD + TITLE_H + HEAD_H / 2);
  }

  // セル
  const todayKey = ymd(new Date());
  const gridTop = PAD + TITLE_H + HEAD_H;
  for (let i = 0; i < model.totalDays; i++) {
    const d = new Date(model.startDate); d.setDate(model.startDate.getDate() + i);
    const col = i % 7, row = Math.floor(i / 7);
    const x = PAD + col * (CELL_W + GAP);
    const yTop = gridTop + row * (CELL_H + GAP);
    const key = ymd(d);

    ctx.save();
    if (d.getMonth() !== model.m) ctx.globalAlpha = 0.45;  // 当月外
    ctx.fillStyle = C.bg2;
    ctx.fillRect(x, yTop, CELL_W, CELL_H);
    if (col === 5) { ctx.fillStyle = C.satBg; ctx.fillRect(x, yTop, CELL_W, CELL_H); }
    if (col === 6) { ctx.fillStyle = C.sunBg; ctx.fillRect(x, yTop, CELL_W, CELL_H); }

    // 日付数字
    ctx.fillStyle = C.tx2;
    ctx.font = `12px ${family}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(String(d.getDate()), x + 4, yTop + 4);

    // アイテム（icon + ×N）。セル内の余白を活かすため、全アイテムが収まる
    // 最大アイコンサイズを試算してから描画する（収まらない分は +n で打ち切り）。
    const perDay = model.byDay.get(key);
    if (perDay) {
      const entries = [...perDay].filter(([wid]) => iconMap.has(wid));
      if (entries.length > 0) {
        const IGAP = 4;
        const areaX = x + 4, areaY = yTop + 20;
        const areaW = CELL_W - 8, areaH = yTop + CELL_H - 4 - areaY;
        const labelFont = s => `bold ${Math.max(10, Math.round(s * 0.45))}px ${family}`;

        // wrap レイアウトを試算し、areaW×areaH に全件収まるか判定
        const fits = (size) => {
          ctx.font = labelFont(size);
          const lineH = size + 3;
          let cx = 0, cy = 0;
          for (const [, count] of entries) {
            const w = size + 2 + ctx.measureText(`×${count}`).width;
            if (cx > 0 && cx + w > areaW) { cx = 0; cy += lineH; }
            if (cy + size > areaH) return false;
            cx += w + IGAP;
          }
          return true;
        };
        let size = Math.min(52, areaH);
        for (; size > 14; size -= 2) { if (fits(size)) break; }

        ctx.font = labelFont(size);
        const lineH = size + 3;
        let cx = areaX, cy = areaY, drawn = 0;
        for (const [wid, count] of entries) {
          const label = `×${count}`;
          const itemW = size + 2 + ctx.measureText(label).width;
          if (cx > areaX && cx + itemW > areaX + areaW) { cx = areaX; cy += lineH; }
          if (cy + size > areaY + areaH) {
            // 最小サイズでも収まらない残数
            ctx.fillStyle = C.tx2;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(`+${entries.length - drawn}`, cx, yTop + CELL_H - 18);
            break;
          }
          const ent = iconMap.get(wid);
          if (ent.img) {
            ctx.drawImage(ent.img, cx, cy, size, size);
          } else {
            ctx.fillStyle = C.bg1;
            ctx.fillRect(cx, cy, size, size);
            ctx.fillStyle = C.tx2;
            ctx.font = `${Math.round(size * 0.5)}px ${family}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('?', cx + size / 2, cy + size / 2);
            ctx.font = labelFont(size);
          }
          ctx.fillStyle = C.acc;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, cx + size + 2, cy + size / 2);
          cx += itemW + IGAP;
          drawn++;
        }
      }
    }

    // 今日枠
    if (key === todayKey) {
      ctx.strokeStyle = C.acc;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, yTop + 0.5, CELL_W - 1, CELL_H - 1);
    }
    ctx.restore();
  }

  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('toBlob failed');
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

// スクショボタンの結果フィードバック。✓/✕ を約 1.5 秒表示してから復帰。
// 再描画でボタン要素が差し替わっている可能性があるため毎回引き直す。
function flashCalShotButton(mark) {
  const btn = elDashboard?.querySelector('.dash-drop-cal-shot');
  if (btn) { btn.textContent = mark; btn.disabled = true; }
  setTimeout(() => {
    calShotBusy = false;
    const b = elDashboard?.querySelector('.dash-drop-cal-shot');
    if (b) { b.textContent = '📷'; b.removeAttribute('disabled'); }
  }, 1500);
}

// ── ダッシュボード レンダリング ────────────────────────
function renderDashboard() {
  if (!elDashboard) return;
  checkDailyReset();
  let dirty = false;
  if (pruneExpiredEventAdventHosts()) dirty = true;
  if (pruneExpiredActiveEvents())     dirty = true;
  if (pruneExpiredEventBanners())     dirty = true;
  if (dirty) saveHostHistory();

  const summaryHTML = buildHostSummaryHTML();
  const dropHTML    = buildDropLogHTML();
  const eventsHTML  = buildActiveEventsBannerHTML();
  const eventsSection = eventsHTML
    ? `<div class="dash-section dash-section-events">
         <div class="dash-section-title">${esc(t('dashEventsTitle'))}</div>
         ${eventsHTML}
       </div>`
    : '';

  elDashboard.innerHTML = `${summaryHTML}${eventsSection}${dropHTML}`;
  wireActiveEventClicks(elDashboard);
}

// ── Hell skip プルダウン HTML 生成 ────────────────────
// 上限 = min(残り回数, 10)。初期選択値は常に最大値（=末尾の option）。
function buildHellSkipDropdownHtml(max) {
  const opts = [];
  for (let i = 1; i <= max; i++) {
    const selected = (i === max) ? ' selected' : '';
    opts.push(`<option value="${i}"${selected}>${i}${esc(t('hostHellSkipOptSuffix'))}</option>`);
  }
  return `<select class="hell-skip-select" title="skip回数">${opts.join('')}</select>`;
}

// ── Hell タイルクリック → skip URL 直遷移 / extra フォールバック ─────
// hellSkipParams 観測済みかつ skipCount > 0 なら str_params URL へ直遷移し、
// content.js に MYQUEST_HELL_PRIME を投げて pendingHellHost を仕込む。
// 実際の消費は GBF 内 Support OK + 離脱時に HELL_QUEST_CONSUMED で確定する。
// 観測無しは従来通り #quest/extra へ。
async function hostHellQuest(questId, skipCount) {
  const tab = await getGBFTab();
  if (!tab) return;
  const meta   = questId ? questMeta[questId] : null;
  const params = meta?.hellSkipParams;
  let url = 'https://game.granbluefantasy.jp/#quest/extra';
  let primed = false;

  if (params && params.questIdNumeric && params.questType
      && Number.isFinite(skipCount) && skipCount > 0) {
    const back = params.backLink || 'quest!extra!event';
    // is_new_skip は hell の種類により URL に含まれる場合（新型 hell）と
    // 含まれない場合（トレジャーレイド等）がある。観測時の URL を忠実に再現する。
    // isNewSkip === null → URL に無かった、含めない
    // isNewSkip === '1' 等 → そのまま埋める
    // undefined（旧バージョン保存エントリ）→ 後方互換で '1' fallback
    const includesNewSkip = (params.isNewSkip !== null && params.isNewSkip !== undefined);
    const newSkipFragment = includesNewSkip
      ? `&is_new_skip=${params.isNewSkip || '1'}`
      : '';
    url = `https://game.granbluefantasy.jp/#quest/supporter/str_params/quest_id=${params.questIdNumeric}&quest_type=${params.questType}&skip_count=${skipCount}&is_event_hell_skip=1${newSkipFragment}&back_link=${back}`;
    params.lastUsedSkipCount = skipCount;
    primed = true;
  }

  try {
    if (primed) {
      // 消費は HELL_QUEST_CONSUMED（Support OK + 離脱）に委ねる。
      // content.js に pendingHellHost を仕込ませる。
      try {
        // hostHistory 側に保持している eventName を引き継ぐ
        //  (meta には保存していないため、該当 questId の行から拾う)。
        const histRow = hostHistory.find(r => String(r.questId) === String(questId));
        const histEventName = (histRow && typeof histRow.eventName === 'string') ? histRow.eventName : '';
        await chrome.tabs.sendMessage(tab.id, {
          type:             'MYQUEST_HELL_PRIME',
          questId,
          skipNum:          skipCount,
          before:           Number.isFinite(meta?.limitedCount) ? meta.limitedCount : null,
          chapterName:      meta?.chapterName || '',
          hostThumbnailSrc: meta?.hostThumbnailSrc || meta?.questThumbnailSrc || '',
          eventPeriodEndMs: Number.isFinite(meta?.eventPeriodEndMs) ? meta.eventPeriodEndMs : null,
          eventName:        histEventName,
          hellSkipParams:   params,
        });
      } catch (_) { /* content script が未注入 (= ゲーム外ページ) なら諦め */ }
      saveHostHistory(); // params.lastUsedSkipCount の永続化
    }
    await chrome.tabs.update(tab.id, { url, active: true });
  } catch (e) {
    console.error('Hell quest navigation error:', e);
  }
}

// ── 自発遷移（履歴カードクリック） ─────────────────────
async function hostQuest(card, entry) {
  if (card.classList.contains('depleted')) return;
  const hasTreasureId = !!entry.treasureId && entry.treasureId !== 'false';
  const url = hasTreasureId
    ? `https://game.granbluefantasy.jp/#quest/supporter/${entry.questId}/${entry.questType}/0/${entry.treasureId}`
    : `https://game.granbluefantasy.jp/#quest/supporter/${entry.questId}/${entry.questType}`;
  const tab = await getGBFTab();
  if (!tab) return;
  try {
    panelHostExpect = { questId: String(entry.questId), ts: Date.now() };
    await chrome.tabs.update(tab.id, { url, active: true });
  } catch (e) {
    panelHostExpect = null;
    console.error('Host quest error:', e);
  }
}

// ── フィルター変更イベント ─────────────────────────────
function onFilterChange() {
  elHpValDisplay.textContent = elHpVal.value;
  elMemValDisplay.textContent = elMemVal.value;
  readSettingsFromUI();
  updateFilterBlockState();
  updateCondUI();
  activeTplId = null;
  renderTemplates();
  saveAll();
  renderFiltered();
}
[elHpOn, elMemOn, elBpOn, elSort].forEach(el => el.addEventListener('change', onFilterChange));
[elHpVal, elMemVal].forEach(el => el.addEventListener('input', onFilterChange));
[elHpModeToggle, elMemModeToggle].forEach(toggle => {
  toggle.addEventListener('click', e => {
    const btn = e.target.closest('.mode-btn');
    if (!btn) return;
    setModeToggle(toggle, btn.dataset.mode);
    onFilterChange();
  });
});

// ── 条件パネル開閉 ────────────────────────────────────
// 開くとリストを下へ押し出す（重ねない）。開閉状態は保存して次回起動へ引き継ぐ。
if (btnCond) {
  btnCond.addEventListener('click', () => {
    setCondPanelOpen(!settings.condOpen);
    saveAll();
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && settings.condOpen) {
    setCondPanelOpen(false);
    saveAll();
    btnCond?.focus();
  }
});

// ── アイコンバー切替 ──────────────────────────────────
elIconBar.addEventListener('click', (e) => {
  const btn = e.target.closest('.icon-btn');
  if (!btn || !btn.dataset.tab) return;
  const tab = btn.dataset.tab;
  if (tab === 'info' && activeTab === 'info') {
    switchTab(prevTab);
  } else {
    if (tab === 'info') prevTab = activeTab;
    switchTab(tab);
  }
});

// ── マイクエスト カテゴリフィルタ（ALL 以外は複数選択可） ──
if (elHostCategoryBar) {
  elHostCategoryBar.addEventListener('click', (e) => {
    const chip = e.target.closest('.cat-chip');
    if (!chip || !chip.dataset.cat) return;
    const cat = chip.dataset.cat;
    let cur = [...getHostCategoryFilters()];

    if (cat === 'all') {
      cur = ['all'];                          // ALL クリックで単独選択
    } else {
      cur = cur.filter(c => c !== 'all');     // ALL を解除
      if (cur.includes(cat)) {
        cur = cur.filter(c => c !== cat);     // 選択解除
      } else {
        cur.push(cat);                        // 追加
      }
      if (cur.length === 0) cur = ['all'];    // 空なら ALL に戻す
    }
    settings.hostCategoryFilters = cur;
    applyHostCategoryFilter();
    saveAll();
    refreshHostViews();
  });
}

// ── アイコンバー位置 / カラム数切替 ──────────────────────────────
[
  { id: 'icon-bar-pos-btns',      apply: applyIconBarPos },
  { id: 'host-history-cols-btns', apply: () => { applyHostHistoryCols(); if (activeTab === 'host-history') renderHostHistory(); } },  // cols はマイクエスト専用
].forEach(({ id, apply }) => {
  document.getElementById(id).addEventListener('click', e => {
    const pill = e.target.closest('.pill[data-value]');
    if (!pill) return;
    setPillValue(id, pill.dataset.value);
    readSettingsFromUI(); apply(); saveAll();
  });
});

// 完了クエスト非表示トグル（マイクエストヘッダ）
btnHideDepleted.addEventListener('click', () => {
  settings.hideDepleted = !settings.hideDepleted;
  btnHideDepleted.classList.toggle('active', settings.hideDepleted);
  saveAll();
  if (activeTab === 'host-history') renderHostHistory();
});

// 本日上限解除トグル（マイクエストヘッダ）
// 対象は現在のカテゴリフィルタを通る非 hell エントリ。
// 対象内に灰色が 1 件でもあれば解除を付与し、無ければ対象内の解除をすべて取り消す。
btnDepletedOverride.addEventListener('click', () => {
  checkDailyReset();
  const targets = hostHistory.filter(rec =>
    passesCategoryFilter(rec) && !questMeta[rec.questId]?.isHellQuest
  );
  const depleted = targets.filter(rec => isHostEntryDepleted(rec));
  if (depleted.length > 0) {
    for (const rec of depleted) {
      if (!questMeta[rec.questId]) questMeta[rec.questId] = {};
      questMeta[rec.questId].overrideDate = hostHistoryDate;
    }
  } else {
    for (const rec of targets) {
      const m = questMeta[rec.questId];
      if (m) delete m.overrideDate;
    }
  }
  saveHostHistory();
  renderHostHistory();
});

elShowEventBanner.addEventListener('change', () => {
  readSettingsFromUI();
  saveAll();
  if (activeTab === 'host-history') renderHostHistory();
});

elHideJoined.addEventListener('change', () => {
  readSettingsFromUI();
  saveAll();
  if (activeTab === 'rescue') renderFiltered();
});

// ログ保持設定は今後の削除操作にのみ効くため再描画不要
elKeepDropLog.addEventListener('change', () => {
  readSettingsFromUI();
  saveAll();
});

btnSettings.addEventListener('click', () => {
  settingsPanel.classList.toggle('open');
  btnSettings.classList.toggle('active', settingsPanel.classList.contains('open'));
  if (settingsPanel.classList.contains('open')) renderDropWatchEditor();
});

// ── ドロップウォッチ編集 UI（アイコンチップ式 + 常設URL入力） ───────
// 追加ルート: ①フッター「最近観測ドロップ」のチップクリック ②設定パネル下部の URL 入力欄
const elDropWatchChips = document.getElementById('drop-watch-chips');
const elDropWatchUrl   = document.getElementById('drop-watch-url');
const btnDropUrlOk     = document.getElementById('btn-drop-url-ok');
const elDropWatchErr   = document.getElementById('drop-watch-input-error');
const btnDropReset     = document.getElementById('btn-drop-reset');

function saveDropWatch() {
  chrome.storage.local.set({ gbfRfDropWatch: dropWatch });
}

// 同 (category, itemId) が既に登録されているか
function findWatchByKey(category, itemId) {
  return dropWatch.find(w => w.category === category && String(w.itemId) === String(itemId));
}

// 再追加時の復元: archive に同 id（makeWatchId は決定的）が残っていれば
// name / iconCached を新エントリへ引き継ぎ、archive から除去する。
function restoreWatchFromArchive(entry) {
  const arch = dropWatchArchive.find(a => a && a.id === entry.id);
  if (!arch) return;
  if (!entry.name && arch.name) entry.name = arch.name;
  if (arch.iconCached) entry.iconCached = arch.iconCached;
  dropWatchArchive = dropWatchArchive.filter(a => a && a.id !== entry.id);
  saveDropWatchArchive();
}

// 未キャッシュのアイコンを background に取りに行く。pending Set で重複抑制。
function ensureDropIconsCached() {
  for (const w of dropWatch) {
    if (!w || w.iconCached) continue;
    if (dropIconFetchPending.has(w.id)) continue;
    const url = buildIconUrl(w.category, w.itemId);
    dropIconFetchPending.add(w.id);
    chrome.runtime.sendMessage({ type: 'DROP_ICON_FETCH', watchId: w.id, iconUrl: url })
      .catch(() => { dropIconFetchPending.delete(w.id); });
  }
}

// 設定 URL 入力欄経由: 任意の m/.jpg | s/.jpg | b/.png URL からウォッチ追加。
// 不正 URL のみエラー、重複は silent no-op。
function addDropWatchFromUrl(url) {
  const p = parseAssetUrl(url);
  if (!p) return { ok: false, reason: 'invalid' };
  if (findWatchByKey(p.category, p.itemId)) return { ok: false, reason: 'dup' };
  if (dropWatch.length >= DROP_WATCH_MAX) return { ok: false, reason: 'limit' };
  const entry = {
    id:         makeWatchId(p.category, p.itemId),
    name:       '',
    category:   p.category,
    itemId:     p.itemId,
    iconCached: '',
    addedAt:    Date.now(),
  };
  restoreWatchFromArchive(entry);
  dropWatch.push(entry);
  saveDropWatch();
  ensureDropIconsCached();
  return { ok: true };
}

// フッターチップ経由: content.js が観測した (category, itemId) から追加。
// 表示用 s/.jpg は描画時に組み立て。重複は silent no-op。
function addDropWatchFromObserved(category, itemId) {
  if (!category || !itemId) return { ok: false, reason: 'invalid' };
  if (findWatchByKey(category, itemId)) return { ok: false, reason: 'dup' };
  if (dropWatch.length >= DROP_WATCH_MAX) return { ok: false, reason: 'limit' };
  const entry = {
    id:         makeWatchId(category, itemId),
    name:       '',
    category,
    itemId:     String(itemId),
    iconCached: '',
    addedAt:    Date.now(),
  };
  restoreWatchFromArchive(entry);
  dropWatch.push(entry);
  saveDropWatch();
  ensureDropIconsCached();
  return { ok: true };
}

function renderDropWatchEditor() {
  if (!elDropWatchChips) return;
  if (dropWatch.length === 0) {
    elDropWatchChips.innerHTML = '';
    return;
  }
  const chipsHTML = dropWatch.map((w, i) => {
    const iconSrc = w.iconCached || buildIconUrl(w.category, w.itemId);
    const label   = w.name || `${w.category}/${w.itemId}`;
    return `<button class="drop-chip" data-index="${i}" title="${esc(label)} — ${esc(t('settingsDropChipDelTitle'))}">
      <img src="${esc(iconSrc)}" alt="" loading="lazy" decoding="async">
    </button>`;
  }).join('');
  elDropWatchChips.innerHTML = chipsHTML;

  elDropWatchChips.querySelectorAll('.drop-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const idx = parseInt(chip.dataset.index, 10);
      if (!Number.isInteger(idx)) return;
      const removed = dropWatch[idx];
      dropWatch.splice(idx, 1);
      if (removed) {
        if (settings.keepDropLogOnRemove) {
          // ログ保持: メタ情報を archive へ退避（カレンダー描画で参照し続ける）
          dropWatchArchive = dropWatchArchive.filter(a => a && a.id !== removed.id);
          dropWatchArchive.push({
            id: removed.id, name: removed.name, category: removed.category,
            itemId: removed.itemId, iconCached: removed.iconCached, removedAt: Date.now(),
          });
          pruneDropWatchArchive();  // イベントが 1 件も無い watch を消した場合の即掃除
          saveDropWatchArchive();
        } else {
          // 取得イベントから該当 watchId のものを削除（ダッシュボードから消える）
          const before = dropEvents.length;
          dropEvents = dropEvents.filter(ev => ev && ev.watchId !== removed.id);
          if (dropEvents.length !== before) {
            chrome.storage.local.set({ gbfRfDropEvents: dropEvents });
          }
          // 過去に設定 ON で退避した archive が残っていれば孤児化するので除去
          if (dropWatchArchive.some(a => a && a.id === removed.id)) {
            dropWatchArchive = dropWatchArchive.filter(a => a && a.id !== removed.id);
            saveDropWatchArchive();
          }
        }
      }
      saveDropWatch();
      renderDropWatchEditor();
      if (activeTab === 'dashboard') renderDashboard();
      renderRecentDropsFooter();
    });
  });
}

// URL 入力欄ハンドラ（常設表示）
function submitDropWatchUrl() {
  const url = elDropWatchUrl?.value?.trim() || '';
  if (!url) return;
  const r = addDropWatchFromUrl(url);
  if (r.ok || r.reason === 'dup') {
    if (elDropWatchUrl) elDropWatchUrl.value = '';
    if (elDropWatchErr) elDropWatchErr.textContent = '';
    renderDropWatchEditor();
    renderRecentDropsFooter();
    if (activeTab === 'dashboard') renderDashboard();
  } else if (r.reason === 'limit') {
    if (elDropWatchErr) elDropWatchErr.textContent = t('settingsDropUrlErrLimit');
  } else {
    if (elDropWatchErr) elDropWatchErr.textContent = t('settingsDropUrlErrInvalid');
  }
}
if (btnDropUrlOk) btnDropUrlOk.addEventListener('click', submitDropWatchUrl);
if (elDropWatchUrl) {
  elDropWatchUrl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitDropWatchUrl(); }
  });
  elDropWatchUrl.addEventListener('input', () => {
    // 入力中はエラー文をクリアして再入力しやすく
    if (elDropWatchErr && elDropWatchErr.textContent) elDropWatchErr.textContent = '';
  });
}

if (btnDropReset) {
  btnDropReset.addEventListener('click', () => {
    if (!confirm(t('settingsDropResetConfirm'))) return;
    dropEvents = [];
    seenResultKeys = {};
    dropWatchArchive = [];  // イベント全消しに伴い archive も存在意義を失う
    chrome.storage.local.set({ gbfRfDropEvents: dropEvents, gbfRfSeenResultKeys: seenResultKeys, gbfRfDropWatchArchive: dropWatchArchive });
    if (activeTab === 'dashboard') renderDashboard();
    renderRecentDropsFooter();
  });
}

// ── 最近観測ドロップ フッター ────────────────────────
const elRecentDropsFooter = document.getElementById('recent-drops-footer');
const elRecentDropsChips  = document.getElementById('recent-drops-chips');
const elRecentDropsEmpty  = document.getElementById('recent-drops-empty');

// ドロップアイコン画像（CDN s/.jpg）の存在判定キャッシュ（セッション内のみ、key = "category:itemId"）。
// NG 判明分は以後描画をスキップし、未判定分は load 成功まで hidden にする。
const dropIconOkKeys = new Set();
const dropIconNgKeys = new Set();

function renderRecentDropsFooter() {
  if (!elRecentDropsFooter) return;
  if (!Array.isArray(lastResultDrops) || lastResultDrops.length === 0) {
    if (elRecentDropsChips) elRecentDropsChips.innerHTML = '';
    if (elRecentDropsEmpty) elRecentDropsEmpty.hidden = false;
    return;
  }
  if (elRecentDropsEmpty) elRecentDropsEmpty.hidden = true;
  if (!elRecentDropsChips) return;

  elRecentDropsChips.innerHTML = lastResultDrops.map(d => {
    const key = `${d.category}:${d.itemId}`;
    // s サイズ画像が存在しないと判明済みのアイテム（event/article 等）は描画しない
    if (dropIconNgKeys.has(key)) return '';
    const registeredWatch = findWatchByKey(d.category, d.itemId);
    const registered = !!registeredWatch;
    // 表示は s/.jpg 固定。既ウォッチ済みなら base64 dump (iconCached) を優先 → ストレージから瞬時表示。
    // 未登録は CDN の s/.jpg 直 URL（設定 UI / ダッシュボードと同 URL のためブラウザキャッシュが効く）。
    const iconSrc = (registeredWatch && registeredWatch.iconCached)
      ? registeredWatch.iconCached
      : buildIconUrl(d.category, d.itemId);
    // 画像の有無が未判定のチップは load 成功まで hidden にしてチラつき
    // （破損アイコンが一瞬表示 → 消える）を防ぐ
    const pendingIcon = !(registeredWatch && registeredWatch.iconCached) && !dropIconOkKeys.has(key);
    const countBadge = (d.count > 1)
      ? `<span class="recent-drop-count">×${d.count}</span>` : '';
    const checkBadge = registered ? `<span class="recent-drop-check">✓</span>` : '';
    const cls = `recent-drop-chip${registered ? ' is-registered' : ''}`;
    const title = registered ? t('recentDropAddedTitle') : t('recentDropAddTitle');
    return `<button class="${cls}"${pendingIcon ? ' hidden' : ''} data-cat="${esc(d.category)}" data-id="${esc(d.itemId)}" title="${esc(title)}">
      <img src="${esc(iconSrc)}" alt="" decoding="async">
      ${countBadge}
      ${checkBadge}
    </button>`;
  }).join('');

  elRecentDropsChips.querySelectorAll('.recent-drop-chip').forEach(chip => {
    const img = chip.querySelector('img');
    if (img) {
      const key = `${chip.dataset.cat}:${chip.dataset.id}`;
      img.addEventListener('load',  () => { dropIconOkKeys.add(key); chip.hidden = false; });
      img.addEventListener('error', () => { dropIconNgKeys.add(key); chip.hidden = true; });
    }
    chip.addEventListener('click', () => {
      if (chip.classList.contains('is-registered')) return; // 既登録は no-op
      const cat = chip.dataset.cat;
      const id  = chip.dataset.id;
      const r = addDropWatchFromObserved(cat, id);
      if (r.ok) {
        // 即時に ✓ バッジ表示。再描画で他チップ状態も同期。
        renderRecentDropsFooter();
        renderDropWatchEditor();
        if (activeTab === 'dashboard') renderDashboard();
      }
    });
  });
}

btnAssist.addEventListener('click', async () => {
  const tab = await getGBFTab();
  if (!tab) return;
  await chrome.tabs.update(tab.id, { url: 'https://game.granbluefantasy.jp/#quest/assist', active: true });
});

btnAssistUnclaimed.addEventListener('click', async () => {
  const tab = await getGBFTab();
  if (!tab) return;
  await chrome.tabs.update(tab.id, { url: 'https://game.granbluefantasy.jp/#quest/assist/unclaimed/0/0', active: true });
});

// 削除ボタン（アクティブカテゴリ限定／ALL 時は全削除）
btnClearHistory.addEventListener('click', () => {
  if (!hostHistory.length) return;
  const cats  = getHostCategoryFilters();
  const isAll = cats.includes('all');

  // 削除対象を決定
  const targets = isAll
    ? hostHistory.slice()
    : hostHistory.filter(r =>
        cats.includes(r.raidCategory || questMeta[r.questId]?.raidCategory || 'etc')
      );
  if (!targets.length) return;

  const msg = isAll
    ? t('confirmClearAll', { count: targets.length })
    : t('confirmClearCat', { count: targets.length });
  if (!confirm(msg)) return;

  if (isAll) {
    hostHistory = [];
  } else {
    const targetIds = new Set(targets.map(t => t.questId));
    hostHistory = hostHistory.filter(r => !targetIds.has(r.questId));
  }
  saveHostHistory();
  renderHostHistory();
});

btnTplAdd.addEventListener('click', openTplNameRow);
btnTplCancel.addEventListener('click', closeTplNameRow);
btnTplSave.addEventListener('click', () => {
  const name = tplNameInput.value.trim();
  if (!name) { tplNameInput.focus(); return; }
  const tpl = filterSnapshot(name);
  templates.push(tpl);
  activeTplId = tpl.id;
  saveAll(); renderTemplates(); closeTplNameRow();
});
tplNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter')  btnTplSave.click();
  if (e.key === 'Escape') closeTplNameRow();
});

// ── 初期化 ────────────────────────────────────────────
(async () => {
  // 初期タブを body クラスへ反映（dashboard / rescue / host-history / info の排他）
  document.body.classList.add(`tab-${activeTab}`);

  // バージョンをmanifestから自動取得
  const { version } = chrome.runtime.getManifest();
  const versionLabel = document.getElementById('version-label');
  if (versionLabel) versionLabel.textContent = t('versionLabel', { v: version });
  const infoVersionLabel = document.getElementById('info-version-label');
  if (infoVersionLabel) infoVersionLabel.textContent = t('versionLabel', { v: version });

  await loadAll();
  await loadHostHistory();
  // 開発期間中は中国語固定（JA/EN ボタン非表示中）
  if (settings.lang !== 'zh') {
    settings.lang = 'zh';
    saveAll();
  }
  applyI18n('zh');
  applySettingsToUI();
  renderTemplates();
  renderFavBar();

  // 新リリース通知（非ブロッキング・lazy 6h 判定は関数内）
  checkForUpdate();
  document.getElementById('update-banner-close')?.addEventListener('click', dismissUpdateBanner);

  // ドロップウォッチのアイコンを未取得分だけ background に依頼
  ensureDropIconsCached();
  // フッター（最近観測ドロップ）初期描画
  renderRecentDropsFooter();

  // 初期タブ（ダッシュボード）を描画。救援リストも裏で読み込んでおく。
  renderDashboard();
  load(false);

  // 開きっぱなし対策: 60秒ごとに期限切れ event エントリ・activeEvents を掃除
  setInterval(() => {
    let dirty = false;
    if (pruneExpiredActiveEvents())     dirty = true;
    if (pruneExpiredEventAdventHosts()) dirty = true;
    if (pruneExpiredEventBanners())     dirty = true;
    if (dirty) {
      saveHostHistory();
      refreshHostViews();
    }
  }, 60_000);
})();
