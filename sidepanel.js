// GBF Raid Filter - Side Panel Script v1.2.2

const DEFAULTS = {
  hpOn: false, hpMode: 'above', hpVal: 50,
  memOn: false, memMode: 'below', memVal: 5,
  bpOn: false,
  sort: 'default',
  iconBarPos: 'left',
  hostHistoryCols: 3,
  hostCategoryFilters: ['all'],
  hideDepleted: true,
  showEventBanner: true,
  lang: 'zh',
};

let allRaids    = [];
let isLoading   = false;
let settings    = { ...DEFAULTS };
let templates   = [];
let activeTplId = null;
let favorites   = [null, null, null, null, null]; // { url, title } | null

// ── BP 状態 ──────────────────────────────────────────
// currentBP: GBF DOM から取れた現在の BP。null = 未取得（救援タブ非表示時など）
// panelLockUntilBp: ロック中の閾値。currentBP が これ以上 になったら自動解除
let currentBP = null;
let panelLockUntilBp = null;

// ── マイクエスト状態 ────────────────────────────────────
let activeTab       = 'rescue';   // 'rescue' | 'host-history' | 'info'
let prevTab         = 'rescue';   // info タブ離脱先
let hostHistory     = [];         // [{ questId, questType, treasureId, lastTimestamp, todayCount, raidCategory, eventPeriodEndMs? }]
let questMeta       = {};         // { [questId]: { chapterName, limitedCount, maxLimitedCount, ... } }
let hostHistoryDate = '';         // GBF日付文字列
// 開催中／予告イベント。content.js が #event/.. または #teaser/.. を踏むたびに更新。periodEndMs 経過で自動除去。
let activeEvents    = {};         // { [eventName]: { eventName, title, periodText, periodEndMs, hash, lastSeenAt } }
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

const elHpOn    = document.getElementById('hp-on');
const elHpMode  = document.getElementById('hp-mode');
const elHpVal   = document.getElementById('hp-val');
const elHpBlock = document.getElementById('hp-block');
const elMemOn   = document.getElementById('mem-on');
const elMemMode = document.getElementById('mem-mode');
const elMemVal  = document.getElementById('mem-val');
const elMemBlock= document.getElementById('mem-block');
const elBpOn    = document.getElementById('bp-on');
const elBpBlock = document.getElementById('bp-block');
const elSort    = document.getElementById('sort');

const elIconBarPosGroup      = document.getElementById('icon-bar-pos-btns');
const elHostHistoryColsGroup = document.getElementById('host-history-cols-btns');
const elHideDepleted    = document.getElementById('hide-depleted');
const elShowEventBanner = document.getElementById('show-event-banner');
const elIconBar   = document.getElementById('icon-bar');
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
      resolve();
    });
  });
}

function applySettingsToUI() {
  elHpOn.checked     = settings.hpOn;
  elHpMode.value     = settings.hpMode;
  elHpVal.value      = settings.hpVal;
  elMemOn.checked    = settings.memOn;
  elMemMode.value    = settings.memMode;
  elMemVal.value     = settings.memVal;
  elBpOn.checked     = settings.bpOn;
  elSort.value       = settings.sort;
  setPillValue('icon-bar-pos-btns',      settings.iconBarPos || 'left');
  setPillValue('host-history-cols-btns', String(settings.hostHistoryCols || 3));
  elHideDepleted.checked     = !!settings.hideDepleted;
  elShowEventBanner.checked  = !!settings.showEventBanner;
  applyIconBarPos();
  applyHostHistoryCols();
  applyHostCategoryFilter();
  updateFilterBlockState();
  updateLangPicker(settings.lang || 'zh');
}

const setPillValue = (id, v) =>
  document.querySelectorAll(`#${id} .pill`).forEach(b =>
    b.classList.toggle('active', b.dataset.value === String(v)));

const getPillValue = (id, fb) =>
  document.querySelector(`#${id} .pill.active`)?.dataset.value ?? fb;

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
  saveAll();
  if (activeTab === 'rescue') renderFiltered();
  else if (activeTab === 'host-history') renderHostHistory();
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
  settings.hpMode  = elHpMode.value;
  settings.hpVal   = parseFloat(elHpVal.value) || 50;
  settings.memOn   = elMemOn.checked;
  settings.memMode = elMemMode.value;
  settings.memVal  = parseInt(elMemVal.value, 10) || 5;
  settings.bpOn    = elBpOn.checked;
  settings.sort    = elSort.value;
  settings.iconBarPos      = getPillValue('icon-bar-pos-btns', 'left');
  settings.hostHistoryCols = parseInt(getPillValue('host-history-cols-btns', '3'), 10) || 3;
  settings.hideDepleted    = elHideDepleted.checked;
  settings.showEventBanner = elShowEventBanner.checked;
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
function renderFavBar() {
  for (let i = 0; i < 5; i++) {
    const btn = document.querySelector(`.fav-btn[data-index="${i}"]`);
    const rm  = document.querySelector(`.fav-remove[data-index="${i}"]`);
    if (!btn || !rm) continue;
    if (favorites[i]) {
      btn.textContent = String(i + 1);
      btn.classList.add('filled');
      btn.title = favorites[i].title ? `${favorites[i].title}\n${favorites[i].url}` : favorites[i].url;
      rm.classList.add('visible');
    } else {
      btn.textContent = '+';
      btn.classList.remove('filled');
      btn.title = '';
      rm.classList.remove('visible');
    }
  }
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
  if (!silent) {
    setListHTML(`<div class="loading-state"><div class="spinner"></div>${t('msgLoading')}</div>`);
    elCount.innerHTML = t('countEmpty');
  }

  const tab = await getGBFTab();
  if (!tab) {
    setListHTML(`<div class="err">${t('msgNoGbf')}</div>`);
    done(); return;
  }
  try {
    const res = await askContent(tab.id, { type: 'GET_RAIDS' });
    if (!res) throw new Error(t('msgNoResponse'));
    allRaids = res.raids || [];
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
    renderFiltered();
  } catch (e) {
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
      if (activeTab === 'host-history') renderHostHistory();
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
    if (activeTab === 'host-history') renderHostHistory();
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
    }
    saveHostHistory();
    if (activeTab === 'host-history') renderHostHistory();
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

    const existing = hostHistory.find(r => String(r.questId) === String(qid));
    if (existing) {
      existing.todayCount    = (existing.todayCount || 0) + 1;
      existing.lastTimestamp = now;
      existing.raidCategory  = 'event';
      if (Number.isFinite(message.eventPeriodEndMs)) {
        existing.eventPeriodEndMs = message.eventPeriodEndMs;
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
      hostHistory.push(row);
    }

    recentHostDecrementAt[qid] = now;
    saveHostHistory();
    if (activeTab === 'host-history') renderHostHistory();
  } else if (message.type === 'ENEMY_IMG_RESOLVED') {
    if (message.questId && message.thumbnailSrc) {
      if (!questMeta[message.questId]) questMeta[message.questId] = {};
      questMeta[message.questId].enemyImgSrc = message.thumbnailSrc;
      saveHostHistory();
      if (activeTab === 'host-history') renderHostHistory();
    }
  } else if (message.type === 'EVENT_INFO_DETECTED') {
    const k = String(message.eventName || '').trim();
    if (!k) return;
    // #event/N 受信時、対応する "teaser:N" を削除してキー重複を防ぐ。
    // Teaser から取得した eventStartMs/eventEndMs を引き継ぐ。
    if (!message.isTeaser) {
      const numId = String(message.hash || '').match(/^#event\/(\d+)/)?.[1];
      if (numId) {
        const tk = `teaser:${numId}`;
        if (activeEvents[tk]) {
          if (!Number.isFinite(message.eventStartMs)) message.eventStartMs = activeEvents[tk].eventStartMs;
          if (!Number.isFinite(message.eventEndMs))   message.eventEndMs   = activeEvents[tk].eventEndMs;
          delete activeEvents[tk];
        }
      }
    }
    const existing = activeEvents[k];
    activeEvents[k] = {
      eventName:    k,
      title:        String(message.title || '').trim() || k,
      periodText:   String(message.periodText || ''),
      periodEndMs:  Number.isFinite(message.periodEndMs) ? message.periodEndMs : null,
      hash:         typeof message.hash === 'string' ? message.hash : '',
      isTeaser:     !!message.isTeaser,
      isEnding:     !!message.isEnding,
      lastSeenAt:   Date.now(),
      eventStartMs: Number.isFinite(message.eventStartMs) ? message.eventStartMs : (existing?.eventStartMs ?? null),
      eventEndMs:   Number.isFinite(message.eventEndMs)   ? message.eventEndMs   : (existing?.eventEndMs   ?? null),
    };
    pruneExpiredActiveEvents();
    saveHostHistory();
    if (activeTab === 'host-history') renderHostHistory();
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
  settings.hpOn = tpl.hpOn; settings.hpMode = tpl.hpMode; settings.hpVal = tpl.hpVal;
  settings.memOn = tpl.memOn; settings.memMode = tpl.memMode; settings.memVal = tpl.memVal;
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
    chip.innerHTML = `<span class="tpl-chip-name">${esc(tpl.name)}</span><span class="tpl-chip-del" title="${esc(t('templateDeleteTitle'))}">✕</span>`;
    chip.querySelector('.tpl-chip-name').addEventListener('click', () => applyTemplate(tpl));
    chip.querySelector('.tpl-chip-del').addEventListener('click', (e) => { e.stopPropagation(); deleteTemplate(tpl.id); });
    templateScroll.appendChild(chip);
  });
}
function openTplNameRow() { tplNameRow.classList.add('open'); tplNameInput.value = ''; tplNameInput.focus(); }
function closeTplNameRow() { tplNameRow.classList.remove('open'); tplNameInput.value = ''; }

// ── Filter / Sort ─────────────────────────────────────
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
function hpCol(p) { return p===null||p>=70?'#3eb503': p>=30?'#ffa826':'#ff4d00'; }
function bpHtml(n, half) {
  let d = ''; for (let i = 0; i < 5; i++) d += `<div class="bp-dot${i<n?' on':''}"></div>`;
  return `<div class="bp-row">${d}${half?'<span class="bp-half">½</span>':''}</div>`;
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
    const h  = r.hpPercent !== null ? `${r.hpPercent.toFixed(0)}%` : '—';
    const m  = r.memberCurrent !== null ? `${r.memberCurrent}/${r.memberMax}` : '—';
    const nm = esc(r.chapterName.length > 24 ? r.chapterName.slice(0,24)+'…' : r.chapterName);
    if (r.isUnknown) {
      return `
<div class="card card-unknown" title="${esc(t('raidTitleUnknown', { cls: r.unknownClasses.join(',') }))}">
  <img class="thumb" src="${esc(r.thumbnailSrc)}" alt="" loading="lazy">
  <div class="info">
    <div class="name">${nm}</div>
    <div class="meta">
      <div class="mi"><span class="mk">HP</span><span class="mv ${hpCls(r.hpPercent)}">${h}</span></div>
      <div class="mi"><span class="mk">${t('raidMkMem')}</span><span class="mv">${m}</span></div>
      ${bpHtml(r.bp, r.isHalf)}
    </div>
    <div class="hp-bar"><div class="hp-fill" style="width:${r.hpPercent??0}%;background:${hpCol(r.hpPercent)}"></div></div>
    <div class="footer">
      <span class="time">⏱ ${esc(r.remainingTime)}</span>
      <span class="owner">👤 ${esc(r.ownerName)}</span>
    </div>
    <div style="font-size:9px;color:#ff4d00;margin-top:2px;">${esc(t('raidUnknownWarn', { cls: r.unknownClasses.join(', ') }))}</div>
  </div>
</div>`;
    }
    return `
<div class="card" data-raid-id="${esc(r.raidId)}" data-raid-url="${esc(r.raidUrl||'')}"
     data-thumb="${esc(r.thumbnailSrc)}" data-name="${esc(r.chapterName)}" data-bp="${r.bp|0}" title="${esc(t('raidClickJoin'))}">
  <img class="thumb" src="${esc(r.thumbnailSrc)}" alt="" loading="lazy">
  <div class="info">
    <div class="name">${nm}</div>
    <div class="meta">
      <div class="mi"><span class="mk">HP</span><span class="mv ${hpCls(r.hpPercent)}">${h}</span></div>
      <div class="mi"><span class="mk">${t('raidMkMem')}</span><span class="mv">${m}</span></div>
      ${bpHtml(r.bp, r.isHalf)}
    </div>
    <div class="hp-bar"><div class="hp-fill" style="width:${r.hpPercent??0}%;background:${hpCol(r.hpPercent)}"></div></div>
    <div class="footer">
      <span class="time">⏱ ${esc(r.remainingTime)}</span>
      <span class="owner">👤 ${esc(r.ownerName)}</span>
    </div>
  </div>
</div>`;
  }).join('');
  elList.querySelectorAll('.card:not(.card-unknown)').forEach(card => {
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
        const numId  = e.hash?.match(/^#teaser\/(\d+)/)?.[1];
        const newKey = numId || k;
        delete activeEvents[k];
        if (!activeEvents[newKey]) {
          activeEvents[newKey] = {
            ...e,
            isTeaser:    false,
            periodEndMs: Number.isFinite(e.eventEndMs) ? e.eventEndMs : null,
            hash:        numId ? `#event/${numId}` : e.hash,
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

/** #event/advent 由来で eventPeriodEndMs があるマイクエストを、終了後に履歴から除去 */
function pruneExpiredEventAdventHosts() {
  const now = Date.now();
  const catOf = (r) => r.raidCategory || questMeta[r.questId]?.raidCategory || 'etc';

  // 期限不明 event エントリの一掃判定:
  //   - activeEvents が空 (= 観測した全イベントが終了済み) かつ
  //   - 期限既知の event エントリが 1 つ以上あり、それらが全部期限切れ
  // を満たす場合のみ、期限不明 event エントリも巻き込んで削除する。
  // → 旧データ救済用。観測なし状態での誤削除は起きない。
  const eventEntries = hostHistory.filter(r => catOf(r) === 'event');
  const knownEnds = eventEntries.filter(r => Number.isFinite(r.eventPeriodEndMs));
  const allKnownExpired = knownEnds.length > 0 && knownEnds.every(r => r.eventPeriodEndMs <= now);
  const sweepUnknown = Object.keys(activeEvents).length === 0 && allKnownExpired;

  const next = hostHistory.filter((r) => {
    if (catOf(r) !== 'event') return true;
    const end = r.eventPeriodEndMs;
    if (!Number.isFinite(end)) return !sweepUnknown;
    return now < end;
  });
  if (next.length === hostHistory.length) return false;
  hostHistory = next;
  return true;
}

/** raidCategory === 'etc' のうち lastTimestamp が 7 日以上前のものを削除 */
function pruneStaleEtcHosts() {
  const STALE_MS = 7 * 24 * 60 * 60 * 1000;
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
    chrome.storage.local.get(['gbfRfHostHistory', 'gbfRfQuestMeta', 'gbfRfHostHistoryDate', 'gbfRfEnemyImgCache', 'gbfRfActiveEvents'], data => {
      hostHistory     = migrateHostHistoryIfNeeded(data.gbfRfHostHistory || []);
      questMeta       = data.gbfRfQuestMeta       || {};
      hostHistoryDate = data.gbfRfHostHistoryDate  || '';
      activeEvents    = (data.gbfRfActiveEvents && typeof data.gbfRfActiveEvents === 'object') ? data.gbfRfActiveEvents : {};
      // 後方互換: 旧形式（isTeaser フィールド未保存）の救済。eventName が teaser:NNN なら teaser として扱う。
      for (const e of Object.values(activeEvents)) {
        if (e && typeof e === 'object' && e.isTeaser === undefined) {
          e.isTeaser = typeof e.eventName === 'string' && e.eventName.startsWith('teaser:');
        }
        if (e && typeof e === 'object' && e.isEnding === undefined) {
          e.isEnding = false;
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
      if (pruneStaleEtcHosts())           dirty = true;
      if (dirty) saveHostHistory();
      resolve();
    });
  });
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
  });
}

function checkDailyReset() {
  const today = getGBFDateString();
  if (hostHistoryDate !== today) {
    // パネル（クエスト一覧）は保持し、本日の回数だけリセット
    hostHistory.forEach(r => { r.todayCount = 0; });
    hostHistoryDate = today;
    // 日付が変わったら残り回数をmaxに戻す
    for (const qid in questMeta) {
      const m = questMeta[qid];
      // Hell クエストは日付変更で初期化されない（クリア時に確率で増えるのみ）
      if (m.isHellQuest) continue;
      if (m.maxLimitedCount != null) m.limitedCount = m.maxLimitedCount;
      // PRO quest: max は questId ごとの固定値なので保持し、残り回数のみ max に戻す
      if (m.maxProQuestSkip != null) m.proQuestSkip = m.maxProQuestSkip;
    }
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
  document.body.classList.remove('tab-rescue', 'tab-host-history', 'tab-info');
  document.body.classList.add(`tab-${tab}`);
  if (tab === 'rescue') {
    load(false);
  } else if (tab === 'host-history') {
    renderHostHistory();
  }
  // info タブは静的コンテンツのみのため再描画不要
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
// 「ALL もしくは event カテゴリ選択中」のときだけ非空 HTML を返す。
// 終了時刻 (periodEndMs) を過ぎたエントリは除外し、近い順にソート。
function buildActiveEventsBannerHTML() {
  if (!settings.showEventBanner) return '';
  if (!shouldShowEventBanner()) return '';
  const now = Date.now();

  const teasers = [];
  const actives = [];
  const ended   = [];
  for (const e of Object.values(activeEvents)) {
    if (e.isTeaser) {
      teasers.push(e);
    } else if (e.isEnding) {
      ended.push(e);
    } else {
      // eventEndMs 優先。なければ periodEndMs（後方互換）
      const endMs = Number.isFinite(e.eventEndMs) ? e.eventEndMs : e.periodEndMs;
      if (!Number.isFinite(endMs) || endMs > now) actives.push(e);
      else ended.push(e);
    }
  }
  if (teasers.length + actives.length + ended.length === 0) return '';

  // teaser / active は締切が近い順、ended は終了が新しい順
  teasers.sort((a, b) => (a.periodEndMs ?? Infinity) - (b.periodEndMs ?? Infinity));
  actives.sort((a, b) => (a.periodEndMs ?? Infinity) - (b.periodEndMs ?? Infinity));
  ended.sort((a, b)   => (b.periodEndMs ?? 0)        - (a.periodEndMs ?? 0));

  const rowHTML = (e) => `
    <div class="active-event-row">
      <a class="active-event-name" href="#"
         data-event-name="${esc(e.eventName)}"
         data-hash="${esc(e.hash || '')}">${esc(e.title)}</a>
      <span class="active-event-period">${esc(e.periodText)}</span>
      <button class="active-event-del" data-event-name="${esc(e.eventName)}" title="削除">×</button>
    </div>`;

  const groupHTML = (cls, labelKey, list) => list.length === 0 ? '' : `
    <div class="event-group ${cls}">
      <span class="event-group-label">${esc(t(labelKey))}</span>
      <div class="event-group-rows">${list.map(rowHTML).join('')}</div>
    </div>`;

  return `<div class="active-events">${
    groupHTML('event-group-teaser', 'eventGroupTeaser', teasers)
  }${
    groupHTML('event-group-active', 'eventGroupActive', actives)
  }${
    groupHTML('event-group-ended',  'eventGroupEnded',  ended)
  }</div>`;
}

// ── マイクエスト レンダリング ──────────────────────────
function renderHostHistory() {
  checkDailyReset();
  let dirty = false;
  if (pruneExpiredEventAdventHosts()) dirty = true;
  if (pruneExpiredActiveEvents())     dirty = true;
  if (dirty) saveHostHistory();
  elHostDate.textContent = hostHistoryDate;

  // rec.raidCategory → questMeta → 'etc' の優先でカテゴリ解決
  const resolveCat = (rec) =>
    rec.raidCategory || questMeta[rec.questId]?.raidCategory || 'etc';

  // 1エントリが depleted（残り自発回数 0）かを判定。PRO は proQuestSkip、それ以外は limitedCount。
  // Hell は max 常に n1 と同値仕様 (0/0 を許容) のため、max>0 ガードを外し remaining===0 で判定する。
  const isEntryDepleted = (rec) => {
    const meta = questMeta[rec.questId] || null;
    if (!meta) return false;
    const cat  = resolveCat(rec);
    const isPro = cat === 'pro';
    if (meta.isHellQuest) {
      return Number.isFinite(meta.limitedCount) && meta.limitedCount <= 0;
    }
    const max       = isPro ? meta.maxProQuestSkip : meta.maxLimitedCount;
    const remaining = isPro ? meta.proQuestSkip    : meta.limitedCount;
    const hasLimit  = typeof max === 'number' && max > 0;
    return hasLimit && typeof remaining === 'number' && remaining <= 0;
  };

  // カテゴリ表示順（.cat-chip 並びに準拠）と見出しラベル
  const CAT_ORDER = ['event', 'pro', 'nm', 'hl', 'ul', 'free', 'etc'];
  const CAT_LABEL = {
    event: t('catLabelEvent'), pro: 'PRO', nm: 'NORMAL', hl: 'HIGH LEVEL', ul: 'UNLIMITED',
    free: t('catLabelFree'), etc: t('catLabelOther'),
  };

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

  const eventBannerHTML = buildActiveEventsBannerHTML();

  if (entries.length === 0) {
    const msg = hostHistory.length === 0
      ? t('hostNoQuests')
      : t('hostNoCatQuests');
    setListHTML(`${eventBannerHTML}<div class="state"><div class="ico">📋</div><p>${msg}</p></div>`);
    wireActiveEventClicks();
    return;
  }

  const renderTile = (entry) => {
    const meta     = entry.meta;
    const name     = meta?.chapterName || `Quest ${entry.questId}`;
    const isPro    = entry.raidCategory === 'pro';
    const max      = isPro ? meta?.maxProQuestSkip : meta?.maxLimitedCount;
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
    const limitInfo = (Number.isFinite(max) && Number.isFinite(remaining))
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
  // event カテゴリの直前には開催中イベントバナーを差し込む（event グループが空 / 全自発済みでもバナーは出す）
  let bannerEmitted = false;
  const sections = CAT_ORDER.map(cat => {
    // event は他カテゴリより先にバナーだけ先取りする（hideDepleted で全自発済みでも出す）
    let banner = '';
    if (cat === 'event' && !bannerEmitted) {
      banner = eventBannerHTML;
      bannerEmitted = true;
    }
    if (settings.hideDepleted && categoryClearState[cat]) return banner;
    const group = entries.filter(e => (e.raidCategory || 'etc') === cat);
    if (group.length === 0) return banner;  // event 空でもバナーだけ返す
    const header = `<div class="host-group-header host-cat-${esc(cat)}"><span class="host-group-label">(${esc(CAT_LABEL[cat])})</span><span class="host-group-line"></span></div>`;
    const grid = `<div class="host-grid">${group.map(renderTile).join('')}</div>`;
    return `${banner}<div class="host-group">${header}${grid}</div>`;
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

  wireActiveEventClicks();
}

// バナー内イベント名クリック → 取得元 hash があればそれ、無ければ #event/{event_name}
function wireActiveEventClicks() {
  elList.querySelectorAll('.active-event-name').forEach(a => {
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      const name = a.dataset.eventName;
      const hash = a.dataset.hash || '';
      if (!name && !hash) return;
      const tab = await getGBFTab();
      if (!tab) return;
      const targetUrl = hash
        ? `https://game.granbluefantasy.jp/${hash}`
        : `https://game.granbluefantasy.jp/#event/${name}`;
      try {
        await chrome.tabs.update(tab.id, { url: targetUrl, active: true });
      } catch (err) {
        console.error('Active event navigation error:', err);
      }
    });
  });
  elList.querySelectorAll('.active-event-del').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const name = btn.dataset.eventName;
      if (name) { delete activeEvents[name]; saveHostHistory(); renderHostHistory(); }
    });
  });
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
    url = `https://game.granbluefantasy.jp/#quest/supporter/str_params/quest_id=${params.questIdNumeric}&quest_type=${params.questType}&skip_count=${skipCount}&is_event_hell_skip=1&back_link=${back}`;
    params.lastUsedSkipCount = skipCount;
    primed = true;
  }

  try {
    if (primed) {
      // 消費は HELL_QUEST_CONSUMED（Support OK + 離脱）に委ねる。
      // content.js に pendingHellHost を仕込ませる。
      try {
        await chrome.tabs.sendMessage(tab.id, {
          type:             'MYQUEST_HELL_PRIME',
          questId,
          skipNum:          skipCount,
          before:           Number.isFinite(meta?.limitedCount) ? meta.limitedCount : null,
          chapterName:      meta?.chapterName || '',
          hostThumbnailSrc: meta?.hostThumbnailSrc || meta?.questThumbnailSrc || '',
          eventPeriodEndMs: Number.isFinite(meta?.eventPeriodEndMs) ? meta.eventPeriodEndMs : null,
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
  readSettingsFromUI();
  updateFilterBlockState();
  activeTplId = null;
  renderTemplates();
  saveAll();
  renderFiltered();
}
[elHpOn, elMemOn, elBpOn, elHpMode, elMemMode, elSort].forEach(el => el.addEventListener('change', onFilterChange));
[elHpVal, elMemVal].forEach(el => el.addEventListener('input', onFilterChange));

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
    if (activeTab === 'host-history') renderHostHistory();
  });
}

// ── アイコンバー位置 / カラム数切替 ──────────────────────────────
[
  { id: 'icon-bar-pos-btns',      apply: applyIconBarPos },
  { id: 'host-history-cols-btns', apply: () => { applyHostHistoryCols(); if (activeTab === 'host-history') renderHostHistory(); } },
].forEach(({ id, apply }) => {
  document.getElementById(id).addEventListener('click', e => {
    const pill = e.target.closest('.pill[data-value]');
    if (!pill) return;
    setPillValue(id, pill.dataset.value);
    readSettingsFromUI(); apply(); saveAll();
  });
});

elHideDepleted.addEventListener('change', () => {
  readSettingsFromUI();
  saveAll();
  if (activeTab === 'host-history') renderHostHistory();
});

elShowEventBanner.addEventListener('change', () => {
  readSettingsFromUI();
  saveAll();
  if (activeTab === 'host-history') renderHostHistory();
});

btnSettings.addEventListener('click', () => {
  settingsPanel.classList.toggle('open');
  btnSettings.classList.toggle('active', settingsPanel.classList.contains('open'));
});

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
  // 初期タブを body クラスへ反映（rescue / host-history / info の 3 値排他）
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

  document.querySelectorAll('.fav-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.dataset.index);
      const tab = await getActiveTab();
      if (!tab || !tab.url) return;
      if (favorites[idx]) {
        chrome.tabs.update(tab.id, { url: favorites[idx].url, active: true });
      } else {
        favorites[idx] = { url: tab.url, title: tab.title || '' };
        saveFavorites();
        renderFavBar();
      }
    });
  });

  document.querySelectorAll('.fav-remove').forEach(rm => {
    rm.addEventListener('click', e => {
      e.stopPropagation();
      const idx = Number(rm.dataset.index);
      favorites[idx] = null;
      saveFavorites();
      renderFavBar();
    });
  });

  load(false);

  // 開きっぱなし対策: 60秒ごとに期限切れ event エントリ・activeEvents を掃除
  setInterval(() => {
    let dirty = false;
    if (pruneExpiredActiveEvents())     dirty = true;
    if (pruneExpiredEventAdventHosts()) dirty = true;
    if (dirty) {
      saveHostHistory();
      if (activeTab === 'host-history') renderHostHistory();
    }
  }, 60_000);
})();
