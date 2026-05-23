// HamuBle - Content Script v1.2.2

(function () {
  // content script が再注入された場合の二重イベント登録を防止
  if (window.__gbfRaidFilterContentInitialized) return;
  window.__gbfRaidFilterContentInitialized = true;

  console.log('[hamuble] content.js loaded', location.href);

  // ── Extension context validity ────────────────────
  function isContextValid() {
    try { return !!chrome.runtime?.id; } catch (_) { return false; }
  }

  // ── 自発URL検出用正規表現 ──────────────────────────
  // #quest/supporter/{questId}/{type}
  // #quest/supporter/{questId}/{type}/0/{treasureId}
  // supporter_raid（救援参加）とは区別される
  const SELF_HOST_RE = /^#quest\/supporter\/(\d+)\/(\d+)(?:\/0\/(\d+))?/;
  // hell skip 確定 URL: #quest/supporter/str_params/...is_event_hell_skip=1
  // skip ON で hell ボタン → OK 押下時にこの URL に直遷移し、btn-usual-ok の中間ステップが無い
  const HELL_SKIP_RE = /^#quest\/supporter\/str_params\//;
  const PENDING_HOST_TTL = 120_000; // 120秒で自動失効

  // hell skip URL の `quest_id=…&quest_type=…&...` 部分を { key: value } にパース
  function parseHellSkipUrl(hash) {
    const m = hash.match(/^#quest\/supporter\/str_params\/(.+)$/);
    if (!m) return null;
    const out = {};
    m[1].split('&').forEach(pair => {
      const eq = pair.indexOf('=');
      if (eq < 0) return;
      const k = pair.slice(0, eq);
      const v = pair.slice(eq + 1);
      try { out[k] = decodeURIComponent(v); } catch (_) { out[k] = v; }
    });
    return out;
  }

  /** #event/advent の .prt-period から得た終了時刻（Unix ms）。DOM再描画用に保持 */
  let cachedEventAdventPeriodEndMs = null;

  // ── 自発待機状態 ─────────────────────────────────────
  // サポート召喚石選択ページに遷移した時点で保持し、
  // btn-usual-ok クリック時に確定送信する
  let pendingHost = null;

  // ── Hell ポップアップ追跡 ─────────────────────────────
  // GBF DOM の Hell エントリ(.btn-stage-detail.ex-hell)は data-quest-id を持たないため
  // data-id + data-group から合成 questId を生成して識別する。
  function makeHellQuestId(dataId, dataGroup) {
    return `hell_${dataId}_${dataGroup}`;
  }
  // 直近で開いた Hell ポップアップのコンテキスト。
  // .pop-start-hell 内の btn-usual-ok 確定時に消費数を反映するため保持。
  // { questId, chapterName, eventPeriodEndMs?, hostThumbnailSrc?, ts }
  let activeHellPopup = null;

  // [V2 GBF DOM] hell カテゴリ選択 (.btn-stage-detail.select-hell) → レベル選択 (.btn-select-hell) の
  // 2 段階で hell が確定するため、カテゴリ選択時の data-id/data-group/data-title をここに一時保持する。
  // レベル選択クリック時に消費して activeHellPopup へ繋ぐ。
  // { dataId, dataGroup, title, ts }
  let activeHellCategoryV2 = null;
  const ACTIVE_HELL_CATEGORY_V2_TTL = 120_000;

  // Hell PT選択画面 (#quest/supporter) OK 確定までの保留状態。
  // .pop-start-hell の OK 押下時にスナップショットを取り、
  // supporter 画面の .btn-usual-ok + hashchange 離脱で確定発火する。
  // { questId, chapterName, hostThumbnailSrc, eventPeriodEndMs, before, skipNum, ts, okClickedAt? }
  let pendingHellHost = null;
  const PENDING_HELL_TTL = 120_000;

  function isPendingHellHostValid() {
    if (!pendingHellHost) return false;
    if (Date.now() - pendingHellHost.ts > PENDING_HELL_TTL) {
      pendingHellHost = null;
      return false;
    }
    return true;
  }

  // 直近で確定発火した hell のスナップショット。Retry 経路の起点として使う。
  // pendingHellHost は発火後すぐクリアし、Retry での str_params URL 到達時に
  // ここから新しい pendingHellHost を再構築する。
  // { questId, chapterName, hostThumbnailSrc, eventPeriodEndMs, hellSkipParams, ts }
  let lastFiredHell = null;
  const LAST_FIRED_HELL_TTL = 300_000; // 5分

  function isLastFiredHellValid() {
    if (!lastFiredHell) return false;
    if (Date.now() - lastFiredHell.ts > LAST_FIRED_HELL_TTL) {
      lastFiredHell = null;
      return false;
    }
    return true;
  }

  function fireHellQuestConsumed() {
    if (!pendingHellHost) return;
    console.log('[hamuble:hell] fireHellQuestConsumed', { questId: pendingHellHost.questId, skipOn: pendingHellHost.skipOn, skipNum: pendingHellHost.skipNum });
    const { before, skipNum } = pendingHellHost;
    const after = Number.isFinite(before) ? Math.max(0, before - skipNum) : null;
    chrome.runtime.sendMessage({
      type:              'HELL_QUEST_CONSUMED',
      questId:           pendingHellHost.questId,
      chapterName:       pendingHellHost.chapterName,
      raidCategory:      'event',
      hostThumbnailSrc:  pendingHellHost.hostThumbnailSrc,
      eventPeriodEndMs:  pendingHellHost.eventPeriodEndMs,
      limitedCountAfter: after,
      consumedCount:     skipNum,
      // skip URL から採取した quest_id/quest_type/back_link を sidepanel 側に保存させる。
      // 取得できているのは「skip ON で確定した hell」のみ。skip OFF や未観測の hell では null。
      hellSkipParams:    pendingHellHost.hellSkipParams || null,
    }).catch(() => {});
    // 重複発火防止のため pendingHellHost は確実にクリアする。
    // Retry 経路 (リザルト→もう一度挑戦) は str_params URL を新たに踏むので、
    // hashchange ハンドラで lastFiredHell から pendingHellHost を再構築する。
    lastFiredHell = {
      questId:          pendingHellHost.questId,
      chapterName:      pendingHellHost.chapterName,
      hostThumbnailSrc: pendingHellHost.hostThumbnailSrc,
      eventPeriodEndMs: pendingHellHost.eventPeriodEndMs,
      hellSkipParams:   pendingHellHost.hellSkipParams || null,
      ts:               Date.now(),
    };
    pendingHellHost = null;
  }

  function isPendingHostValid() {
    if (!pendingHost) return false;
    if (Date.now() - pendingHost.ts > PENDING_HOST_TTL) {
      pendingHost = null;
      return false;
    }
    return true;
  }

  function fireSelfHostDetected() {
    if (!pendingHost) return;
    chrome.runtime.sendMessage({
      type: 'SELF_HOST_DETECTED',
      source:     pendingHost.source,
      questId:    pendingHost.questId,
      questType:  pendingHost.questType,
      treasureId: pendingHost.treasureId,
      chapterName: pendingHost.chapterName || '',
      limitedCount: pendingHost.limitedCount,
      maxLimitedCount: pendingHost.maxLimitedCount,
      raidCategory: pendingHost.raidCategory || 'etc',
      isProQuest:   !!pendingHost.isProQuest,
      isRetry:      !!pendingHost.isRetry,
      proQuestSkip: pendingHost.proQuestSkip ?? null,
      eventPeriodEndMs: pendingHost.eventPeriodEndMs ?? null,
      hostThumbnailSrc: pendingHost.hostThumbnailSrc || '',
    }).catch(() => {});
    pendingHost = null;
  }

  function parseDatasetInt(el, keys, fallback = null) {
    if (!el || !el.dataset) return fallback;
    for (const key of keys) {
      const raw = el.dataset[key];
      if (raw === undefined || raw === null || raw === '') continue;
      const parsed = parseInt(raw, 10);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return fallback;
  }

  // data-limited-count（→ limitedCount）と data-limited_count の両方に対応。
  // 回数属性が子要素だけにあるカード向けに、ボタン配下も走査する。
  const LIMIT_COUNT_KEYS = ['limitedCount', 'limited_count'];
  const MAX_LIMIT_KEYS   = ['maxLimitedCount', 'max_limited_count'];

  function readQuestLimitCounts(rootEl) {
    let limitedCount = parseDatasetInt(rootEl, LIMIT_COUNT_KEYS, null);
    let maxLimitedCount = parseDatasetInt(rootEl, MAX_LIMIT_KEYS, null);
    if (limitedCount != null && maxLimitedCount != null) {
      return { limitedCount, maxLimitedCount };
    }
    for (const node of rootEl.querySelectorAll('*')) {
      if (limitedCount == null) {
        const v = parseDatasetInt(node, LIMIT_COUNT_KEYS, null);
        if (v != null) limitedCount = v;
      }
      if (maxLimitedCount == null) {
        const v = parseDatasetInt(node, MAX_LIMIT_KEYS, null);
        if (v != null) maxLimitedCount = v;
      }
      if (limitedCount != null && maxLimitedCount != null) break;
    }
    return { limitedCount, maxLimitedCount };
  }

  // GBFのquest系DOMは data-chapter-name または data-quest-name で quest名を持つ
  function getQuestName(el) {
    if (!el?.dataset) return '';
    return el.dataset.chapterName || el.dataset.questName || '';
  }

  // ── Raid type mapping ─────────────────────────────
  const RAID_TYPE_MAP = {
    'search':       7,
    'guild-member': 4,
    'friend':       3,
  };

  // 装飾系クラス（raidTypeとは無関係）
  const DECORATION_CLASSES = new Set([
    'btn-multi-raid', 'lis-raid', 'show-assist-comment',
  ]);

  // 未知クラスをstorage.localに蓄積
  function logUnknownClasses(classes, dataset) {
    chrome.storage.local.get('gbfRfUnknownClasses', (data) => {
      const log = data.gbfRfUnknownClasses || [];
      log.push({
        time:       new Date().toISOString(),
        classes,
        questId:    dataset.questId    || '',
        raidType:   dataset.raidType   || '',
        chapterName: dataset.chapterName || '',
      });
      if (log.length > 200) log.splice(0, log.length - 200);
      chrome.storage.local.set({ gbfRfUnknownClasses: log });
    });
  }

  // { param: number|null, isUnknown: boolean, unknownClasses: string[] }
  function getRaidTypeParam(el) {
    // 自発（参加不可）
    if (el.dataset.raidType === '0') {
      return { param: null, isUnknown: false, unknownClasses: [] };
    }
    for (const [cls, val] of Object.entries(RAID_TYPE_MAP)) {
      if (el.classList.contains(cls)) {
        return { param: val, isUnknown: false, unknownClasses: [] };
      }
    }
    // 追加クラスなし → 一般公開
    const extra = [...el.classList].filter(c => !DECORATION_CLASSES.has(c));
    if (extra.length === 0) {
      return { param: 2, isUnknown: false, unknownClasses: [] };
    }
    // 未知クラス
    logUnknownClasses(extra, el.dataset);
    return { param: null, isUnknown: true, unknownClasses: extra };
  }

  // 「4/14 17:00 ～ 4/21 16:59」形式（JST）の開始/終了を Unix ms に変換
  function parseEventPeriod(text) {
    if (!text || typeof text !== 'string') return null;
    const t = text.replace(/\u2013|\u2014/g, '-').trim();
    const m = t.match(
      /(\d+)\/(\d+)\s+(\d+):(\d+)\s*[\uFF5E\u301C～〜~\-]\s*(\d+)\/(\d+)\s+(\d+):(\d+)/
    );
    if (!m) return null;
    const sm = parseInt(m[1], 10), sd = parseInt(m[2], 10);
    const sh = parseInt(m[3], 10), smin = parseInt(m[4], 10);
    const em = parseInt(m[5], 10), ed = parseInt(m[6], 10);
    const eh = parseInt(m[7], 10), emin = parseInt(m[8], 10);
    const wallToMs = (y, mo, d, h, min) => {
      const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:00+09:00`;
      const ms = Date.parse(iso);
      return Number.isNaN(ms) ? null : ms;
    };
    const now = new Date();
    const jstMs = now.getTime() + (now.getTimezoneOffset() + 540) * 60000;
    const jst = new Date(jstMs);
    let year = jst.getFullYear();
    const startMs = wallToMs(year, sm, sd, sh, smin);
    let endMs = wallToMs(year, em, ed, eh, emin);
    if (startMs == null || endMs == null) return null;
    if (endMs < startMs) endMs = wallToMs(year + 1, em, ed, eh, emin);
    return { startMs, endMs };
  }

  function detectEventIsEnding(periodText) {
    return typeof periodText === 'string' && periodText.indexOf('エンディング期間') !== -1;
  }

  function isEventAdventHash(hash) {
    return typeof hash === 'string' && /^#event\/advent(\/|$)/.test(hash);
  }

  // #event/... と #teaser/... は #title を共有するが、
  // 開催期間は #event/... が .prt-period、#teaser/... が .txt-teaser-title に置かれる。
  // #event_name は #event/X 系のみ DOM に存在する。teaser は URL の数値 ID で識別する。
  // イベントタブには #event/* / #teaser/*（1 セグメント）のみ反映する。
  // #event/N/M 等のミニイベント／サブページはタイトル・期間が
  // メインイベント(キー "N")を上書きするため、ここで対象外にする。
  function isEventOrTeaserHash(hash) {
    return typeof hash === 'string' && /^#(event|teaser)\/[^/?#]+\/?$/.test(hash);
  }

  function extractEventAdventPeriodEndMs() {
    const el = document.querySelector('.prt-period');
    if (!el) return null;
    return parseEventPeriod(el.textContent || '')?.endMs ?? null;
  }

  function refreshEventAdventPeriodCache() {
    const hash = location.hash || '';
    if (!isEventAdventHash(hash)) return;
    const endMs = extractEventAdventPeriodEndMs();
    if (endMs != null) cachedEventAdventPeriodEndMs = endMs;
  }

  // #event_name は input/value のことも textContent のこともあるので両対応で読む
  function readEventNameElement() {
    const el = document.querySelector('#event_name');
    if (!el) return '';
    const v = ('value' in el && typeof el.value === 'string') ? el.value : '';
    return (v || el.textContent || '').trim();
  }

  // #title は <input type="hidden" value="..."> として置かれているケースがあるため、
  // value を優先し textContent にフォールバックする。
  // #title が存在しないページ（#event/interlude 等）は #prt-head-current を試みる。
  function readTitleElement() {
    const el = document.querySelector('#title');
    if (el) {
      const v = ('value' in el && typeof el.value === 'string') ? el.value : '';
      const t = (v || el.textContent || '').trim();
      if (t) return t;
    }
    return (document.querySelector('#prt-head-current')?.textContent || '').trim();
  }

  function extractEventInfo() {
    const hash = location.hash || '';
    if (!isEventOrTeaserHash(hash)) return null;
    const title = readTitleElement();

    let eventName = readEventNameElement();
    if (!eventName) {
      // #event/X URL の X をフォールバック（ストーリーイベント等で #event_name が空のケース）
      const me = hash.match(/^#event\/([^/?#]+)/);
      if (me) eventName = me[1];
      // #teaser/N は #event_name 要素自体が無いため、teaser ID を独立識別子として使用
      const mt = hash.match(/^#teaser\/(\d+)/);
      if (mt) eventName = `teaser:${mt[1]}`;
    }
    if (!title || !eventName) return null;

    // .prt-period（#event/...）→ cnt-event prt-header（#event/interlude 等）→ .txt-teaser-title（#teaser/...）の順でフォールバック
    let periodText = (document.querySelector('.prt-period')?.textContent || '').trim();
    if (!periodText) {
      periodText = (document.querySelector(
        '#wrapper > div.contents > div.cnt-event > div.prt-header > div'
      )?.textContent || '').trim();
    }
    if (!periodText && /^#teaser\//.test(hash)) {
      const teaserText = (document.querySelector('.txt-teaser-title')?.textContent || '').trim();
      // 「開催期間：」プレフィックスを除去して .prt-period と表示形式を揃える
      periodText = teaserText.replace(/^開催期間\s*[：:]\s*/, '');
    }
    const period = periodText ? parseEventPeriod(periodText) : null;
    // teaser はイベント開始時刻を「activeEvents から消える時刻」として使う。
    // バナー表示は periodText（開始～終了の文字列）のままで変えない。
    const isTeaser = /^#teaser\//.test(hash);
    const isEnding = !isTeaser && detectEventIsEnding(periodText);
    const periodEndMs  = isTeaser ? (period?.startMs ?? null) : (period?.endMs ?? null);
    // タブ移動で失われないよう開始/終了時刻を独立して保持。
    // Ending ページは終了時刻が変わるため eventEndMs は送らず既存値を維持させる。
    const eventStartMs = period?.startMs ?? null;
    const eventEndMs   = !isEnding ? (period?.endMs ?? null) : null;
    return { eventName, title, periodText, periodEndMs, hash, isTeaser, isEnding, eventStartMs, eventEndMs };
  }

  function tryReportEventInfo() {
    if (!isContextValid()) return;
    const info = extractEventInfo();
    if (!info) return;
    // teaser / isEnding のときは periodEndMs を自発履歴キャッシュに混入させない。
    if (!info.isTeaser && !info.isEnding && Number.isFinite(info.periodEndMs)) {
      cachedEventAdventPeriodEndMs = info.periodEndMs;
    }
    chrome.runtime.sendMessage({
      type:         'EVENT_INFO_DETECTED',
      eventName:    info.eventName,
      title:        info.title,
      periodText:   info.periodText,
      periodEndMs:  info.periodEndMs,
      hash:         info.hash,
      isTeaser:     !!info.isTeaser,
      isEnding:     !!info.isEnding,
      eventStartMs: Number.isFinite(info.eventStartMs) ? info.eventStartMs : null,
      eventEndMs:   Number.isFinite(info.eventEndMs)   ? info.eventEndMs   : null,
    }).catch(() => {});
  }

  // ── 難易度カテゴリ判定（自発クリック時のページ文脈から） ─
  // 戻り値: 'free' | 'event' | 'ul' | 'hl' | 'nm' | 'etc'
  function detectRaidCategory() {
    try {
      const hash = location.hash || '';
      if (hash.indexOf('#quest/free') === 0) return 'free';
      if (hash.indexOf('#event/') === 0 || hash.indexOf('#sidestory/') === 0) return 'event';
      // #quest/extra は素材クエスト/イベントの2タブ構成。
      // .btn-stage-type は無いので、タブ active で判定する。
      if (hash.indexOf('#quest/extra') === 0) {
        if (document.querySelector('#tab-event-quest.active')) return 'event';
        return 'etc'; // 素材タブは従来通り etc
      }
      const active = document.querySelector('.btn-stage-type.active[data-stage-type]');
      if (active) {
        const type = active.dataset.stageType;
        if (type === 'calamitous') return 'ul';
        if (type === 'high')       return 'hl';
        if (type === 'normal')     return 'nm';
      }
      return 'etc';
    } catch (_) {
      return 'etc';
    }
  }

  // ── 現在 BP 取得（救援タブ #cnt-quest 配下にのみ存在） ─────
  function extractCurrentBp() {
    const el = document.querySelector('#cnt-quest .prt-user-bp-value[data-current-bp]');
    if (!el) return null;
    const v = parseInt(el.dataset.currentBp, 10);
    return Number.isFinite(v) ? v : null;
  }

  // ── Raid data extraction ──────────────────────────
  function extractRaids() {
    // アクティブなタブのコンテナだけからカードを取得する
    const multiActive  = document.querySelector('#prt-assist-multi.active');
    const searchActive = document.querySelector('#prt-assist-search.active');
    let container = null;
    if (multiActive)       container = document.querySelector('#prt-multi-list');
    else if (searchActive) container = document.querySelector('#prt-search-list');
    const scope = container || document;
    const elements = scope.querySelectorAll('.btn-multi-raid.lis-raid');
    const raids = [];
    elements.forEach((el) => {
      const gaugeInner = el.querySelector('.prt-raid-gauge-inner');
      let hpPercent = null;
      if (gaugeInner) {
        const m = gaugeInner.style.width.match(/([\d.]+)%/);
        if (m) hpPercent = parseFloat(m[1]);
      }
      const fleesIn = el.querySelector('.prt-flees-in');
      let memberCurrent = null, memberMax = null;
      if (fleesIn) {
        const parts = fleesIn.textContent.trim().split('/');
        if (parts.length === 2) { memberCurrent = parseInt(parts[0], 10); memberMax = parseInt(parts[1], 10); }
      }
      const timeEl = el.querySelector('.prt-remaining-time');
      const reqEl  = el.querySelector('.txt-request-name');
      const apEl       = el.querySelector('.prt-use-ap');
      const bp         = parseInt(el.dataset.bp, 10) || 1;
      const bpDecreased = apEl ? apEl.classList.contains('decreased') : false;
      const raidId     = el.dataset.raidId    || '';
      const questId    = el.dataset.questId   || '';
      const questType  = el.dataset.type || el.dataset.questType || '1';
      const raidTypeResult = getRaidTypeParam(el);
      const raidUrl = (raidId && questId && raidTypeResult.param !== null)
        ? `#quest/supporter_raid/${raidId}/${questId}/${questType}/${bp}/0/${raidTypeResult.param}`
        : null;
      const imgEl = el.querySelector('.img-raid-thumbnail');
      const thumbSrc = imgEl?.getAttribute('src') ? imgEl.src : '';
      raids.push({
        raidId, questId, questType, raidUrl,
        isUnknown:     raidTypeResult.isUnknown,
        unknownClasses: raidTypeResult.unknownClasses,
        chapterName:   getQuestName(el),
        hpPercent,
        memberCurrent,
        memberMax,
        remainingTime: timeEl ? timeEl.textContent.trim() : '',
        bp,
        bpDecreased,
        isHalf:        !!el.querySelector('.txt-half-campaign'),
        ownerName:     reqEl ? reqEl.textContent.trim() : '不明',
        thumbnailSrc:  thumbSrc,
      });
    });
    return raids;
  }

  // ── 現在のURLを返す ────────────────────────────────
  function getCurrentUrl() {
    return location.href;
  }

  // ── クエストパネル画像 URL 抽出 ──────────────────────
  // multi/free/extra/free quest-list の各 DOM パターンに対応。
  // event 自発ボタン（.btn-start-multi）は <img> を持たないため意図的に対象外
  // → 取得失敗時は sidepanel 側で enemyImgSrc（バトル画像）にフォールバック。
  function extractQuestThumbnailSrc(el) {
    let src = el.querySelector('.prt-quest-image img.img-quest-thumb')?.getAttribute('src') || '';
    if (src) return src;
    src = el.querySelector('.prt-quest-thumb img.img-quest')?.getAttribute('src') || '';
    if (src) return src;
    // 親コンテナへフォールバック（free 1,2: 内側 .btn-set-quest が画像と兄弟関係 / extra: 内側 .btn-set-quest が空で画像は親 .prt-quest-banner.extra 配下）
    const container = el.closest('.prt-quest-banner, .prt-list-contents, .lis-quest-list, .btn-quest-list');
    if (container && container !== el) {
      src = container.querySelector('.prt-quest-image img.img-quest-thumb')?.getAttribute('src')
         || container.querySelector('.prt-quest-thumb img.img-quest')?.getAttribute('src')
         || '';
      if (src) return src;
    }
    return '';
  }

  // ── クエストメタデータ抽出（回数制限等）─────────────
  // quest名を持つ任意のDOM要素から抽出（クラス依存を廃止）。
  // 新しいクエスト一覧UI（btn-treasure-raid等）が出てもセレクタ追加不要。
  function extractQuestMeta() {
    // フェイトエピソード／共闘クエストページは自発履歴対象外（questMetaにも入れない）
    const hash = location.hash || '';
    if (hash.indexOf('#quest/fate') === 0) return null;
    if (hash.indexOf('#coopraid') === 0)   return null;
    const buttons = document.querySelectorAll(
      '[data-quest-id][data-quest-name], [data-quest-id][data-chapter-name]'
    );
    if (buttons.length === 0) return null;
    const byId = new Map();
    buttons.forEach(el => {
      const questId = el.dataset.questId;
      if (!questId || byId.has(questId)) return;
      const lim = readQuestLimitCounts(el);
      const entry = {
        questId,
        chapterName:      getQuestName(el),
        limitedCountType: parseDatasetInt(el, ['limitedCountType', 'limited_count_type'], null),
        ap:               parseDatasetInt(el, ['ap'], 0),
        difficulty:       el.dataset.difficulty || '',
      };
      // 枯渇状態の .btn-set-quest.disable.has-error 等は data-limited_count を持たないため、
      // null のキーを送信しない（sidepanel 側のスプレッドで保持中の値が上書きされるのを防ぐ）
      if (Number.isFinite(lim.limitedCount))    entry.limitedCount    = lim.limitedCount;
      if (Number.isFinite(lim.maxLimitedCount)) entry.maxLimitedCount = lim.maxLimitedCount;
      // pro quest は別フィールドで管理（isProQuest は true の要素でのみプロパティを含める）
      if (el.dataset.isProQuest === '1') {
        entry.isProQuest   = true;
        entry.proQuestSkip = parseDatasetInt(el, ['proQuestSkip', 'pro_quest_skip'], null);
      }
      // クエスト一覧のバナー画像（PRO一覧の banner_pro_*.png 等）。存在する場合のみ記録。
      const thumbSrc = extractQuestThumbnailSrc(el);
      if (thumbSrc) entry.questThumbnailSrc = thumbSrc;
      byId.set(questId, entry);
    });
    return byId.size > 0 ? [...byId.values()] : null;
  }

  // ── [LEGACY DOM] イベントタブ Hell リストからの残数抽出 ─────────────
  // 旧 GBF DOM の .btn-stage-detail.ex-hell を対象とする実装。現在の GBF DOM では結果 0 件で無害。
  // DOM 改変の法則性比較サンプル、また将来 ex-hell 構造が復活した場合のために残す。
  // 新 DOM 対応は別フェーズで extractEventTabHellMetaV2 等として追加予定。
  // extra ページの「イベント」タブ (#cnt-event-quest.active) 内の
  // 各 Hell エントリ (.btn-stage-detail.ex-hell) について、
  // 兄弟要素 .prt-remain-count .txt-count を真値として取得する。
  // Hell は単一カウンターのため limitedCount = maxLimitedCount = 取得値 とする。
  // 0回 hell は .lis-event-list ごと DOM から消えるため、前回観測 ID と差分を取り
  // 消えた hell は count=0 として送信して sidepanel 側の残数を 0 に同期する。
  let lastEventTabHellIds = new Set();
  function extractEventTabHellMeta() {
    const cnt = document.querySelector('#cnt-event-quest.active');
    if (!cnt) return null;
    const buttons = cnt.querySelectorAll('.btn-stage-detail.ex-hell');
    const meta = [];
    const currentIds = new Set();
    buttons.forEach((btn) => {
      const dataId    = btn.dataset.id    || '';
      const dataGroup = btn.dataset.group || '';
      const title     = btn.dataset.title || '';
      if (!dataId) return;
      const qid = makeHellQuestId(dataId, dataGroup);
      currentIds.add(qid);
      const listItem  = btn.closest('.lis-event-list');
      const countEl   = listItem?.querySelector('.prt-remain-count .txt-count');
      if (!countEl) return;
      const count = parseInt(countEl.textContent.trim() || '', 10);
      if (!Number.isFinite(count)) return;
      const thumbSrc = listItem?.querySelector('.prt-quest-thumb img.img-quest')?.getAttribute('src') || '';
      meta.push({
        questId:           qid,
        chapterName:       title,
        limitedCount:      count,
        maxLimitedCount:   count,
        isHellQuest:       true,
        raidCategory:      'event',
        questThumbnailSrc: thumbSrc,
        hostThumbnailSrc:  thumbSrc,
      });
    });
    // 前回観測されたが今回 DOM から消えた hell は limitedCount=0 として送信。
    // maxLimitedCount は付けない（prev を保持して「残り 0/N」表示にする）。
    // chapterName / thumbSrc も付けないため sidepanel 側で prev が保持される。
    for (const oldId of lastEventTabHellIds) {
      if (currentIds.has(oldId)) continue;
      meta.push({
        questId:      oldId,
        limitedCount: 0,
        isHellQuest:  true,
        raidCategory: 'event',
      });
    }
    lastEventTabHellIds = currentIds;
    return meta.length > 0 ? meta : null;
  }

  function tryExtractEventTabHell() {
    if (!isContextValid()) return;
    const meta = extractEventTabHellMeta();
    if (!meta) return;
    chrome.runtime.sendMessage({
      type: 'QUEST_META_UPDATED',
      questMeta: meta,
    }).catch(() => {});
  }

  // ── MutationObserver ──────────────────────────────
  let notifyTimer = null;
  function notifyUpdate() {
    clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'RAID_LIST_UPDATED' }).catch(() => {});
    }, 150);
  }
  const OBSERVE_TARGETS = ['#prt-multi-list', '#prt-search-list'];
  let raidObservers = [];

  function createObserverCallback() {
    return new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const raidChanged =
          [...mutation.addedNodes, ...mutation.removedNodes].some(
            n => n.nodeType === 1 && (n.classList?.contains('lis-raid') || n.querySelector?.('.lis-raid'))
          ) ||
          (mutation.type === 'attributes' && mutation.target.closest?.('.btn-multi-raid'));
        if (raidChanged) { notifyUpdate(); break; }
      }
    });
  }

  function disconnectObservers() {
    raidObservers.forEach(o => o.disconnect());
    raidObservers = [];
  }

  function startObservers() {
    disconnectObservers();
    for (const sel of OBSERVE_TARGETS) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const obs = createObserverCallback();
      obs.observe(el, { childList: true, attributes: true, attributeFilter: ['style'] });
      raidObservers.push(obs);
    }
    // 接続成功時、既存データをサイドパネルに通知
    if (raidObservers.length > 0) notifyUpdate();
  }

  // コンテナが動的に生成されるため、定期的に探して接続する。
  // 「DOM に存在するコンテナがすべて接続済み」になったら停止。
  // 片方のタブしか表示されない状況でも無限ループしない。
  let attachRetry = null;
  function ensureObservers() {
    const existingCount = OBSERVE_TARGETS.filter(sel => !!document.querySelector(sel)).length;
    if (existingCount > 0 && raidObservers.length >= existingCount) return;
    startObservers();
    if (existingCount === 0 || raidObservers.length < existingCount) {
      if (!attachRetry) attachRetry = setInterval(() => {
        startObservers();
        const ex = OBSERVE_TARGETS.filter(sel => !!document.querySelector(sel)).length;
        if (ex > 0 && raidObservers.length >= ex) { clearInterval(attachRetry); attachRetry = null; }
      }, 1000);
    }
  }
  if (document.body) ensureObservers();
  else document.addEventListener('DOMContentLoaded', ensureObservers, { once: true });

  function bootEventAdventPeriodCache() {
    if (!isContextValid()) return;
    if (!isEventAdventHash(location.hash || '')) return;
    refreshEventAdventPeriodCache();
    setTimeout(() => { if (isContextValid()) refreshEventAdventPeriodCache(); }, 400);
    setTimeout(() => { if (isContextValid()) refreshEventAdventPeriodCache(); }, 1500);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootEventAdventPeriodCache, { once: true });
  } else {
    bootEventAdventPeriodCache();
  }

  // extra event タブが既にアクティブな状態で content script が注入されたケース。
  // DOM 描画を待って Hell リストの残数を抽出。
  function bootEventTabHellExtraction() {
    if (!isContextValid()) return;
    if ((location.hash || '').indexOf('#quest/extra') !== 0) return;
    setTimeout(tryExtractEventTabHell, 400);
    setTimeout(tryExtractEventTabHell, 1500);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootEventTabHellExtraction, { once: true });
  } else {
    bootEventTabHellExtraction();
  }

  // ── タブ切り替え検知（新着マルチ↔救援検索）─────────────
  // ゲーム側のタブボタンがクリックされたら拡張側もリセットして再読み込み
  document.addEventListener('click', (e) => {
    if (!isContextValid()) return;
    const tabBtn = e.target.closest('#tab-multi, #tab-search');
    if (!tabBtn) return;
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'RAID_TAB_SWITCHED' }).catch(() => {});
    }, 250);
  }, true);

  // ── extra ページのタブ切替検知（素材↔イベント）────────
  // イベントタブが active になったタイミングで Hell リストを再抽出。
  document.addEventListener('click', (e) => {
    if (!isContextValid()) return;
    const tabBtn = e.target.closest('#tab-event-quest');
    if (!tabBtn) return;
    setTimeout(tryExtractEventTabHell, 300);
    setTimeout(tryExtractEventTabHell, 1200);
  }, true);

  // ── btn-stage-detail クリック検知（回数メタ取得）────────
  // 詳細パネルが開くと .btn-set-quest が描画される
  // 描画待ちのため2段階で試行
  document.addEventListener('click', (e) => {
    if (!isContextValid()) return;
    if (!e.target.closest('.btn-stage-detail')) return;
    const tryExtract = () => {
      if (!isContextValid()) return;
      const meta = extractQuestMeta();
      if (meta) {
        chrome.runtime.sendMessage({
          type: 'QUEST_META_UPDATED',
          questMeta: meta,
        }).catch(() => {});
      }
    };
    setTimeout(tryExtract, 500);
    setTimeout(tryExtract, 1500);
  }, true);

  // ── [LEGACY DOM] Hell ボタン (.btn-stage-detail.ex-hell) クリック検知 ───────
  // 旧 GBF DOM 用。現在の GBF では .ex-hell クラスが消えておりマッチしない。
  // 新 DOM 対応は下方の「[V2 GBF DOM] hell カテゴリ選択 / レベル選択」ハンドラを参照。
  // DOM 改変の法則性比較サンプルとして残す。
  // 残数の取得は extra event タブ表示時 (extractEventTabHellMeta) に行うため、
  // ここでは Hell コンテキスト（questId / title / サムネ）を保持するだけ。
  // skip popup OK 押下時に pendingHellHost へ昇格する入口。
  document.addEventListener('click', (e) => {
    if (!isContextValid()) return;
    const hellBtn = e.target.closest('.btn-stage-detail.ex-hell');
    if (!hellBtn) return;

    const dataId    = hellBtn.dataset.id    || '';
    const dataGroup = hellBtn.dataset.group || '';
    const title     = hellBtn.dataset.title || '';
    if (!dataId) return;

    const questId  = makeHellQuestId(dataId, dataGroup);
    const listItem = hellBtn.closest('.lis-event-list');
    const thumbSrc = listItem?.querySelector('.prt-quest-thumb img.img-quest')?.getAttribute('src') || '';
    const eventPeriodEndMs =
      isEventAdventHash(location.hash || '') ? extractEventAdventPeriodEndMs() : null;

    activeHellPopup = {
      questId,
      chapterName: title,
      hostThumbnailSrc: thumbSrc,
      eventPeriodEndMs,
      ts: Date.now(),
    };
    console.log('[hamuble:hell] ex-hell click → activeHellPopup', activeHellPopup);
  }, true);

  // ── [LEGACY DOM] Hell skip 選択ポップアップ OK (.pop-start-hell .btn-usual-ok) ──
  // 旧 GBF DOM 用。現在の GBF では .pop-start-hell クラスは無く .prt-start-event-hell 構造になった。
  // 新 DOM 対応は下方の「[V2 GBF DOM] hell skip popup OK」ハンドラを参照。
  // 即時消費せず pendingHellHost にスナップショット保存。
  // PT選択 (#quest/supporter) OK + hashchange 離脱で確定する。
  // txt-skip-count の値は consume 計算上の `before` として保持。
  // skip ON: #skip-num-count の値だけ消費 / skip OFF: バトル経路として 1 消費。
  document.addEventListener('click', (e) => {
    if (!isContextValid()) return;
    const okBtn = e.target.closest('.pop-start-hell.pop-show .btn-usual-ok');
    if (!okBtn) return;
    if (!activeHellPopup) return;

    const popup = okBtn.closest('.pop-start-hell.pop-show');
    const skipCheckbox   = popup?.querySelector('#hell-skip-setting');
    const skipNumSelect  = popup?.querySelector('#skip-num-count');
    const txtSkipCountEl = popup?.querySelector('.txt-skip-count');

    const before  = parseInt(txtSkipCountEl?.textContent?.trim() || '', 10);
    const skipOn  = !!(skipCheckbox && skipCheckbox.checked);
    const skipNum = skipOn ? (parseInt(skipNumSelect?.value || '1', 10) || 1) : 1;
    // skip select の option 数を「skip 観測済み」フラグ兼ねて保持。マイクエ側プルダウン上限は別途算出。
    const skipNumOptions = skipNumSelect?.querySelectorAll('option') || [];
    const observedMaxSkip = skipNumOptions.length > 0 ? skipNumOptions.length : null;

    // 通常自発の保留があれば破棄して Hell フローに切替
    pendingHost = null;

    pendingHellHost = {
      questId:          activeHellPopup.questId,
      chapterName:      activeHellPopup.chapterName,
      hostThumbnailSrc: activeHellPopup.hostThumbnailSrc,
      eventPeriodEndMs: activeHellPopup.eventPeriodEndMs,
      before:           Number.isFinite(before) ? before : null,
      skipNum,
      skipOn,
      observedMaxSkip,
      ts:               Date.now(),
    };
    console.log('[hamuble:hell] pop-start-hell OK → pendingHellHost', { skipOn, skipNum, pendingHellHost });
    activeHellPopup = null;
  }, true);

  // ── [V2 GBF DOM] hell カテゴリ選択 (.btn-stage-detail.select-hell) クリック検知 ──
  // 新 DOM では hell 自発が「カテゴリ選択 (.select-hell) → レベル選択 (.btn-select-hell) → skip popup OK」の 3 段階。
  // ここではカテゴリ選択時の data-id/data-group/data-title を一時保持し、レベル選択時に消費して
  // 旧形式 questId `hell_<id>_<group>` を合成する。
  document.addEventListener('click', (e) => {
    if (!isContextValid()) return;
    const catBtn = e.target.closest('.btn-stage-detail.select-hell');
    if (!catBtn) return;

    const dataId    = catBtn.dataset.id    || '';
    const dataGroup = catBtn.dataset.group || '';
    const title     = catBtn.dataset.title || '';
    if (!dataId) return;

    activeHellCategoryV2 = { dataId, dataGroup, title, ts: Date.now() };
    console.log('[hamuble:hell] V2 category select → activeHellCategoryV2', activeHellCategoryV2);
  }, true);

  // ── [V2 GBF DOM] hell レベル選択 (.btn-select-hell) クリック検知 ──
  // 直前にカテゴリ選択 (activeHellCategoryV2) が立っていれば、それを消費して activeHellPopup を立てる。
  // questId は旧形式 makeHellQuestId(dataId, dataGroup) を維持（マイクエスト履歴の互換性）。
  // セレクタは .ico-clear を含めず .btn-select-hell 単体で受ける（.ico-clear はクリア済みマーカー、
  // 未クリア hell には付かない）。誤検知防止のため data-quest-id の有無で hell レベル選択を識別。
  // .btn-select-hell は [data-quest-id][data-chapter-name] を持つため通常自発検知ハンドラにも
  // 同時に拾われる。pendingHost = null で通常経路の暴発を防ぐ。
  // GBF は popup 内 .btn-select-hell でネイティブ click イベントを発火しない（pointerdown ベースの独自処理）。
  // そのため click と pointerdown 両方で listen する。dedup は activeHellCategoryV2 のクリアで自然に成立。
  const handleV2LevelSelect = (e) => {
    if (!isContextValid()) return;
    const levelBtn = e.target.closest('.btn-select-hell');
    if (!levelBtn) return;

    // ハンドラに届いた事実 + 状態を診断ログで可視化（早期 return の切り分け用）
    console.log('[hamuble:hell] V2 level click detected', {
      eventType: e.type,
      className: levelBtn.className,
      questId: levelBtn.dataset.questId,
      chapterName: levelBtn.dataset.chapterName,
      hasActiveCategoryV2: !!activeHellCategoryV2,
      categoryV2Age: activeHellCategoryV2 ? (Date.now() - activeHellCategoryV2.ts) : null,
    });

    if (!levelBtn.dataset.questId) {
      console.log('[hamuble:hell] V2 level click skipped: no data-quest-id');
      return;
    }
    if (!activeHellCategoryV2) {
      console.log('[hamuble:hell] V2 level click skipped: no activeHellCategoryV2');
      return;
    }
    if (Date.now() - activeHellCategoryV2.ts > ACTIVE_HELL_CATEGORY_V2_TTL) {
      console.log('[hamuble:hell] V2 level click skipped: TTL expired');
      activeHellCategoryV2 = null;
      return;
    }

    // [V2] レベル別カードを実現するため questId にレベル識別子 (data-quest-id) を加える。
    // 旧形式 `hell_<id>_<group>` ではカテゴリ単位でしか区別できず、Lv60/Lv90 が同じカードに集約されてしまうため。
    const questIdNumeric = levelBtn.dataset.questId;
    const questId = `hell_${activeHellCategoryV2.dataId}_${activeHellCategoryV2.dataGroup}_${questIdNumeric}`;
    // chapterName はカテゴリ名 + レベル名を結合して識別性を高める。
    // 例: 「不滅に囚われし者 Lv60 新型錬金生物」
    const levelName = levelBtn.dataset.chapterName || '';
    const chapterName = [activeHellCategoryV2.title, levelName].filter(Boolean).join(' ').trim();
    const eventPeriodEndMs =
      isEventAdventHash(location.hash || '') ? extractEventAdventPeriodEndMs() : null;

    // 通常自発の保留があれば破棄して Hell フローに切替（.btn-select-hell が通常経路にも拾われるため）
    pendingHost = null;

    activeHellPopup = {
      questId,
      chapterName,
      hostThumbnailSrc: '', // skip popup の .img-hell-boss から OK 時に取得
      eventPeriodEndMs,
      ts: Date.now(),
      v2: true,
    };
    console.log('[hamuble:hell] V2 level select → activeHellPopup', activeHellPopup);
    activeHellCategoryV2 = null;
  };
  document.addEventListener('click', handleV2LevelSelect, true);
  document.addEventListener('pointerdown', handleV2LevelSelect, true);

  // ── [V2 GBF DOM] hell skip 設定 popup OK (#pop > .prt-popup-footer > .btn-usual-ok) ──
  // 識別キー: 親 #pop 内に .prt-start-event-hell があれば skip 設定 popup の OK と判定。
  // 内側の #hell-skip-setting / #skip-num-count / .txt-skip-count は旧 DOM と同じセレクタを使用。
  // pendingHellHost に昇格すれば後続の supporter OK / HELL_SKIP_RE 経路は既存ロジックがそのまま動く。
  document.addEventListener('click', (e) => {
    if (!isContextValid()) return;
    const okBtn = e.target.closest('.btn-usual-ok');
    if (!okBtn) return;
    const popContainer = okBtn.closest('#pop');
    if (!popContainer) return;
    const hellPopupBody = popContainer.querySelector('.prt-start-event-hell');
    if (!hellPopupBody) return;
    if (!activeHellPopup) return;
    // SELF_HOST_RE 昇格ブロックと同じ TTL ガード。古い activeHellPopup が
    // 別 hell のポップアップ OK で誤って消費されるのを防ぐ。
    if (Date.now() - activeHellPopup.ts > PENDING_HELL_TTL) {
      console.log('[hamuble:hell] V2 skip popup OK skipped: activeHellPopup TTL expired', { age: Date.now() - activeHellPopup.ts });
      activeHellPopup = null;
      return;
    }

    const skipCheckbox   = popContainer.querySelector('#hell-skip-setting');
    const skipNumSelect  = popContainer.querySelector('#skip-num-count');
    const txtSkipCountEl = popContainer.querySelector('.txt-skip-count');

    const before  = parseInt(txtSkipCountEl?.textContent?.trim() || '', 10);
    const skipOn  = !!(skipCheckbox && skipCheckbox.checked);
    const skipNum = skipOn ? (parseInt(skipNumSelect?.value || '1', 10) || 1) : 1;
    const skipNumOptions = skipNumSelect?.querySelectorAll('option') || [];
    const observedMaxSkip = skipNumOptions.length > 0 ? skipNumOptions.length : null;

    // skip popup 内の boss 画像をサムネとして採取
    const hellBossSrc = hellPopupBody.querySelector('.img-hell-boss')?.getAttribute('src') || '';
    const hostThumbnailSrc = hellBossSrc || activeHellPopup.hostThumbnailSrc || '';

    pendingHost = null;

    pendingHellHost = {
      questId:          activeHellPopup.questId,
      chapterName:      activeHellPopup.chapterName,
      hostThumbnailSrc,
      eventPeriodEndMs: activeHellPopup.eventPeriodEndMs,
      before:           Number.isFinite(before) ? before : null,
      skipNum,
      skipOn,
      observedMaxSkip,
      ts:               Date.now(),
    };
    console.log('[hamuble:hell] V2 skip popup OK → pendingHellHost', { skipOn, skipNum, pendingHellHost });
    activeHellPopup = null;
  }, true);

  // ── btn-pro-list クリック検知（PROクエスト一覧のメタ取得）──
  // PRO一覧ページ遷移後の描画を待って extractQuestMeta を実行。
  // 5時以降の初回 DOM 値が sidepanel 側で maxProQuestSkip として固定される。
  document.addEventListener('click', (e) => {
    if (!isContextValid()) return;
    if (!e.target.closest('.btn-pro-list')) return;
    const tryExtract = () => {
      if (!isContextValid()) return;
      const meta = extractQuestMeta();
      if (meta) {
        chrome.runtime.sendMessage({
          type: 'QUEST_META_UPDATED',
          questMeta: meta,
        }).catch(() => {});
      }
    };
    setTimeout(tryExtract, 500);
    setTimeout(tryExtract, 1500);
  }, true);

  // ── 自発確定検知（サポート召喚石選択後のOKボタン）────
  // OKクリック時はフラグのみ設定し、実際の発火はhashchange（ページ遷移）時に行う。
  // 中間ポップアップ（四象ボーナス通知等）のOKで誤爆しないようにするため。
  // Hell 経路 (pendingHellHost) と通常 (pendingHost) の両方をハンドル。
  // Hell skip ON 時は str_params URL (HELL_SKIP_RE) もサポート石選択画面なので許容。
  // GBF は popup 内 .btn-usual-ok でネイティブ click を発火しないケースがあるため、
  // click + pointerdown 両方で listen する。okClickedAt は最新時刻で上書きされるだけなので
  // 重複発火しても問題なし。
  const handleSupporterOkClick = (e) => {
    if (!isContextValid()) return;
    const okEl = e.target.closest('.btn-usual-ok');
    if (!okEl) return;
    // サポート石選択画面以外の .btn-usual-ok（fate開始OK等）での誤更新を防ぐ
    const hash = location.hash || '';
    const onSupporter = SELF_HOST_RE.test(hash);
    const onHellSkip  = HELL_SKIP_RE.test(hash);
    if (!onSupporter && !onHellSkip) return;
    // サポート石画面に重なる中間ポップアップ（PT編成変更確認等）のOKを除外
    if (okEl.closest('.pop-usual')) return;
    // サポート石選択ページの quest バナー（.prt-quest-thumb img.img-quest）を読取り
    const questThumbEl = document.querySelector('.prt-quest-thumb img.img-quest');
    const src = questThumbEl?.getAttribute('src') || '';

    // Hell 経路を優先（pendingHellHost が生きていれば Hell として確定マーク）
    if (isPendingHellHostValid()) {
      if (src) pendingHellHost.hostThumbnailSrc = src;
      pendingHellHost.okClickedAt = Date.now();
      console.log('[hamuble:hell] supporter btn-usual-ok → okClickedAt set', { eventType: e.type, questId: pendingHellHost.questId });
      return;
    }
    // str_params URL は Hell 専用なので、pendingHellHost が無ければ通常経路に流さない
    if (onHellSkip) return;
    if (!isPendingHostValid()) return;
    if (src) pendingHost.hostThumbnailSrc = src;
    pendingHost.okClickedAt = Date.now();
  };
  document.addEventListener('click', handleSupporterOkClick, true);
  document.addEventListener('pointerdown', handleSupporterOkClick, true);
  document.addEventListener('pointerup', handleSupporterOkClick, true);

  // ── 自発クリック検知（quest系DOMをquest名属性で絞って統一）────────
  // data-quest-id だけで closest するとサポート石選択画面の btn-usual-ok 等にも
  // data-quest-id が付いていて pendingHost を暴発上書きしてしまうため、
  // extractQuestMeta と同じ「quest名属性を持つ」条件で絞る。
  // マルチリスト(.btn-multi-raid)の場合のみ raid-type='0'（自発枠）に限定。
  // data-limited_count は参加前の残り自発回数（カウントダウン）を示す。
  document.addEventListener('click', (e) => {
    if (!isContextValid()) return;
    // OK済みの pendingHost は次の hashchange で確定処理されるため上書き保護
    if (pendingHost?.okClickedAt) return;
    // フェイトエピソード／共闘クエストは自発履歴対象外
    const hash = location.hash || '';
    if (hash.indexOf('#quest/fate') === 0) return;
    if (hash.indexOf('#coopraid') === 0)   return;
    const el = e.target.closest(
      '[data-quest-id][data-quest-name], [data-quest-id][data-chapter-name]'
    );
    if (!el) return;
    if (el.classList.contains('btn-multi-raid') && el.dataset.raidType !== '0') return;

    const newQuestId = el.dataset.questId;
    const now = Date.now();

    // 同一 questId の継続クリック（例: Normal 4天使トレジャー消費ポップアップの「捧げる」= .btn-offer）。
    // 中間ボタンは limited_count 等を持たないため、既存 pendingHost を保持し treasureId だけ補う。
    const sameQuest =
      pendingHost &&
      pendingHost.source === 'click' &&
      String(pendingHost.questId) === String(newQuestId) &&
      (now - pendingHost.ts) < PENDING_HOST_TTL;
    if (sameQuest) {
      pendingHost.ts = now;
      if (el.dataset.treasureId && el.dataset.treasureId !== 'false') pendingHost.treasureId = el.dataset.treasureId;
      return;
    }

    // pair-quest 選択ポップアップ（.pop-select-pair-quest 内の .btn-select-pair-quest）は
    // data-limited_count を持たず、残回数は兄弟要素 .txt-limited-count のテキスト（例: "3/3"）、
    // 画像は .img-pair-quest にある。祖先 .prt-quest-one から補完する。
    const lim = readQuestLimitCounts(el);
    let pairThumb = '';
    const pairOne = el.closest('.prt-quest-one');
    if (pairOne) {
      if (lim.limitedCount == null || lim.maxLimitedCount == null) {
        const txt = pairOne.querySelector('.txt-limited-count span')?.textContent || '';
        const m = txt.match(/(\d+)\s*\/\s*(\d+)/);
        if (m) {
          if (lim.limitedCount == null)    lim.limitedCount    = parseInt(m[1], 10);
          if (lim.maxLimitedCount == null) lim.maxLimitedCount = parseInt(m[2], 10);
        }
      }
      pairThumb = pairOne.querySelector('.img-pair-quest')?.getAttribute('src') || '';
    }

    const isProQuest = el.dataset.isProQuest === '1';
    // リザルト [もう一度挑戦]: result ページではカテゴリ判定の手がかりが無いため
    // sidepanel 側で hash-source と同等に扱い、既存タイルの分類を保持する
    const isRetry = el.classList.contains('btn-retry') || el.dataset.retryQuest === '1';
    const category = isProQuest ? 'pro' : detectRaidCategory();
    // event カテゴリ全般で期限を解決する。#event/advent では DOM から直接、それ以外
    // (#quest/extra の event タブ等) では tryReportEventInfo() 等で温まった cache から復元。
    // #sidestory/ は恒久コンテンツなので除外（誤った期限付与で消えるのを防ぐ）。
    let eventPeriodEndMs = null;
    if (category === 'event' && hash.indexOf('#sidestory/') !== 0) {
      const direct = isEventAdventHash(hash) ? extractEventAdventPeriodEndMs() : null;
      eventPeriodEndMs = direct || cachedEventAdventPeriodEndMs;
    }
    pendingHost = {
      source:     'click',
      ts:         now,
      questId:    newQuestId,
      questType:  el.dataset.type || el.dataset.questType || '1',
      treasureId: (el.dataset.treasureId && el.dataset.treasureId !== 'false') ? el.dataset.treasureId : '',
      chapterName: getQuestName(el),
      limitedCount: lim.limitedCount,
      maxLimitedCount: lim.maxLimitedCount,
      raidCategory: category,
      isProQuest,
      isRetry,
      proQuestSkip: isProQuest ? parseDatasetInt(el, ['proQuestSkip', 'pro_quest_skip'], null) : null,
      eventPeriodEndMs,
    };
    if (pairThumb) {
      pendingHost.hostThumbnailSrc = pairThumb;
    } else {
      // bundled-quest-list / extra / free などの .btn-set-quest は
      // 兄弟の .prt-quest-image img.img-quest-thumb に画像を持つ（祖先 .prt-quest-banner 経由で拾う）
      const thumb = extractQuestThumbnailSrc(el);
      if (thumb) pendingHost.hostThumbnailSrc = thumb;
    }
  }, true);

  // ── ハッシュ遷移検知 ───────────────────────────────
  window.addEventListener('hashchange', () => {
    if (!isContextValid()) return;
    const hash = location.hash;

    if (isEventAdventHash(hash)) {
      setTimeout(() => {
        if (!isContextValid()) return;
        refreshEventAdventPeriodCache();
      }, 400);
      setTimeout(() => {
        if (!isContextValid()) return;
        refreshEventAdventPeriodCache();
      }, 1500);
    }

    // 開催中／予告イベントページ: #title / #event_name / .prt-period をサイドパネルに送る
    if (isEventOrTeaserHash(hash)) {
      setTimeout(tryReportEventInfo, 600);
      setTimeout(tryReportEventInfo, 1800);
    }

    // assist ページに来た場合に observer を再接続
    if (hash.includes('quest/assist')) {
      disconnectObservers();
      setTimeout(() => ensureObservers(), 500);
    }

    // PRO skip 実行検出: ready/battle を経由せず #result_pro_quest_skip に直接遷移
    // supporter 経路より先に確定発火させ、pendingHost をクリアする
    if (pendingHost?.isProQuest && hash.startsWith('#result_pro_quest_skip')) {
      fireSelfHostDetected();
      return;
    }

    // 自発検出: サポート召喚石選択ページへの遷移を検知し、情報を保持
    // 実際のカウント・履歴追加は btn-usual-ok クリック時に行う
    const hostMatch = hash.match(SELF_HOST_RE);

    // Hell skip URL (str_params) 到達時: hellSkipParams を採取して保留。
    // 消費発火は通常経路と同じく「サポート OK 押下 → URL 離脱」まで待つ。
    // URL から quest_id / quest_type / back_link を採取して hellSkipParams に詰める
    // (sidepanel 側でマイクエ skip 直遷移用に保存される)。
    if (HELL_SKIP_RE.test(hash) && isPendingHellHostValid()) {
      const params = parseHellSkipUrl(hash);
      if (params && params.is_event_hell_skip === '1') {
        pendingHellHost.hellSkipParams = {
          questIdNumeric:  params.quest_id || '',
          questType:       params.quest_type || '',
          backLink:        params.back_link || 'quest!extra!event',
          observedMaxSkip: pendingHellHost.observedMaxSkip ?? null,
          isNewSkip:       params.is_new_skip || '',
        };
      }
      // skip ON / OFF 問わず、str_params URL 到達後にサポート選択画面が表示され、
      // ユーザーがサポート OK を押すまで実際の消費は確定しない。
      // よってここでは hellSkipParams 採取のみ行い、消費発火は通常通り
      // handleSupporterOkClick で okClickedAt セット → hashchange で leftSupporterArea
      // 判定 → fireHellQuestConsumed のフローに任せる。
    } else if (HELL_SKIP_RE.test(hash) && isLastFiredHellValid()) {
      // Retry 経路: 直前消費の hell snapshot から pendingHellHost を再構築。
      // skipNum は URL の skip_count パラメータが真値（Retry 中は変更不可）。
      const params = parseHellSkipUrl(hash);
      if (params && params.is_event_hell_skip === '1') {
        const skipNum = parseInt(params.skip_count || '1', 10) || 1;
        pendingHellHost = {
          questId:          lastFiredHell.questId,
          chapterName:      lastFiredHell.chapterName,
          hostThumbnailSrc: lastFiredHell.hostThumbnailSrc,
          eventPeriodEndMs: lastFiredHell.eventPeriodEndMs,
          hellSkipParams: {
            questIdNumeric:  params.quest_id || lastFiredHell.hellSkipParams?.questIdNumeric || '',
            questType:       params.quest_type || lastFiredHell.hellSkipParams?.questType || '',
            backLink:        params.back_link || lastFiredHell.hellSkipParams?.backLink || 'quest!extra!event',
            observedMaxSkip: lastFiredHell.hellSkipParams?.observedMaxSkip ?? null,
            isNewSkip:       params.is_new_skip || lastFiredHell.hellSkipParams?.isNewSkip || '',
          },
          before:  null, // 現値不明 → sidepanel 側で consumedCount 経路の減算を取らせる
          skipNum,
          skipOn:  true,
          ts:      Date.now(),
        };
        // Retry チェーン中に str_params hashchange が複数回起きるケース
        // (例: str_params → supporter → str_params → /battle) で重複 rebuild → 二重 fire
        // するのを防ぐため、rebuild 直後に lastFiredHell をクリアする。
        // fireHellQuestConsumed 完了時に lastFiredHell は再 populate されるので、次回 Retry には影響しない。
        lastFiredHell = null;
      }
    }

    // Hell 通常自発（skip ポップアップ未使用）の検出:
    // .btn-stage-detail.ex-hell クリック時に activeHellPopup がセット済み (content.js Hell ボタン検知)。
    // skip ポップアップが出ない hell（skip 未解放等）はサポート石選択画面に直遷移するため、
    // ここで activeHellPopup を pendingHellHost に昇格させ、後続の Support OK + 離脱で
    // HELL_QUEST_CONSUMED を発火させる。skip ON 経路は HELL_SKIP_RE URL 到達時の既存処理が拾うため、
    // SELF_HOST_RE 到達かつ pendingHellHost 未設定の場合のみ昇格する。
    if (hostMatch && !isPendingHellHostValid() && activeHellPopup
        && (Date.now() - activeHellPopup.ts) < PENDING_HELL_TTL) {
      pendingHost = null;
      pendingHellHost = {
        questId:          activeHellPopup.questId,
        chapterName:      activeHellPopup.chapterName,
        hostThumbnailSrc: activeHellPopup.hostThumbnailSrc,
        eventPeriodEndMs: activeHellPopup.eventPeriodEndMs,
        before:           null,
        skipNum:          1,
        skipOn:           false,
        observedMaxSkip:  null,
        ts:               Date.now(),
      };
      console.log('[hamuble:hell] SELF_HOST_RE reached → promote activeHellPopup to pendingHellHost', pendingHellHost.questId);
      activeHellPopup = null;
    }

    // Hell 確定: サポート石選択 OK 押下後に supporter / str_params から離脱したタイミング
    // str_params URL (HELL_SKIP_RE) もサポート石選択画面なので、そこからの離脱も対象。
    const leftSupporterArea = !hostMatch && !HELL_SKIP_RE.test(hash);
    if (pendingHellHost?.okClickedAt && leftSupporterArea
        && (Date.now() - pendingHellHost.okClickedAt) < 1000) {
      fireHellQuestConsumed();
    } else if (leftSupporterArea && pendingHellHost) {
      // 中断 (例: ブラウザ戻るで str_params から離脱、OK 未押下) の場合、
      // pendingHellHost を残すと次の通常 quest の OK click が hijack され、
      // SELF_HOST_DETECTED が抑止 + 古い hell の HELL_QUEST_CONSUMED が誤発火する。
      // okClickedAt 未設定で supporter 圏外に出たら確実にクリア。
      console.log('[hamuble:hell] abort clear pendingHellHost (leftSupporterArea without okClickedAt)', { questId: pendingHellHost.questId, hash });
      pendingHellHost = null;
    } else if (isPendingHellHostValid()) {
      // Hell 保留中は通常 pendingHost の hash 由来セットアップを抑止。
      // (skip popup OK → #quest/supporter 遷移時に source:'hash' pendingHost が
      //  暴発し SELF_HOST_DETECTED と二重発火するのを防ぐ)
    } else if (pendingHost?.okClickedAt && !hostMatch
        && (Date.now() - pendingHost.okClickedAt) < 1000) {
      // OK済み + supporter ページから離脱 + OKクリック直後の自動遷移 → 自発確定
      // 確定OKはゲームが即座にページ遷移するが、戻るボタンは人間操作で遅延がある
      fireSelfHostDetected();
    } else if (pendingHost?.source === 'click') {
      // クリック由来のデータは上書き・クリアしない（TTL切れのみクリア）
      if (Date.now() - pendingHost.ts > PENDING_HOST_TTL) pendingHost = null;
    } else if (hostMatch) {
      pendingHost = {
        source:     'hash',
        ts:         Date.now(),
        questId:    hostMatch[1],
        questType:  hostMatch[2],
        treasureId: hostMatch[3] || '',
      };
    } else {
      pendingHost = null;
    }

    // クエスト一覧ページでメタデータ抽出を試行（DOM描画待ち）
    if (hash.includes('quest/')) {
      setTimeout(() => {
        if (!isContextValid()) return;
        const meta = extractQuestMeta();
        if (meta) {
          chrome.runtime.sendMessage({
            type: 'QUEST_META_UPDATED',
            questMeta: meta,
          }).catch(() => {});
        }
        // extra event タブの Hell リストも併せて抽出
        if (hash.indexOf('#quest/extra') === 0) {
          tryExtractEventTabHell();
        }
      }, 1500);
    }
  });

  // ── メッセージリスナー ─────────────────────────────
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'GET_RAIDS') {
      sendResponse({ raids: extractRaids(), currentBp: extractCurrentBp() });
    } else if (message.type === 'GET_CURRENT_URL') {
      sendResponse({ url: getCurrentUrl() });
    } else if (message.type === 'GET_QUEST_META') {
      sendResponse({ questMeta: extractQuestMeta() });
    } else if (message.type === 'MYQUEST_HELL_PRIME') {
      // サイドパネルが str_params 直遷移を行う直前に投げてくる prime。
      // GBF ネイティブの .pop-start-hell OK と同等の状態を作り、
      // Support OK + 離脱で HELL_QUEST_CONSUMED が飛ぶようにする。
      if (message.questId && Number.isFinite(message.skipNum) && message.skipNum > 0) {
        pendingHost = null; // 通常自発の保留があれば破棄
        pendingHellHost = {
          questId:          message.questId,
          chapterName:      message.chapterName || '',
          hostThumbnailSrc: message.hostThumbnailSrc || '',
          eventPeriodEndMs: Number.isFinite(message.eventPeriodEndMs) ? message.eventPeriodEndMs : null,
          before:           Number.isFinite(message.before) ? message.before : null,
          skipNum:          message.skipNum,
          skipOn:           true,
          observedMaxSkip:  message.hellSkipParams?.observedMaxSkip ?? null,
          hellSkipParams:   message.hellSkipParams || null,
          ts:               Date.now(),
        };
      }
      sendResponse({ ok: true });
    }
    return true;
  });

  // 起動時に既にイベントページ上であれば 1 回試行（hashchange を踏まないケース）
  if (isEventOrTeaserHash(location.hash)) {
    setTimeout(tryReportEventInfo, 600);
    setTimeout(tryReportEventInfo, 1800);
  }

})();
