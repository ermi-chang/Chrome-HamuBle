// HamuBle - Background Service Worker v12.3.1

const GBF_ORIGIN = 'https://game.granbluefantasy.jp/';

// ── 敵画像 ID 捕捉（enemy_{imgId}.js のファイル名から取得）────
// { [tabId]: { questId: string, ids: number[] } }
const enemyImgBuffer = {};

chrome.webRequest.onCompleted.addListener(
  (details) => {
    const tabId = details.tabId;
    if (tabId < 0) return;
    const m = details.url.match(/\/enemy_(\d+)\.js/);
    if (!m) return;
    // アクティブな自発セッションがない場合は無視（orphan防止）
    if (!enemyImgBuffer[tabId]) return;
    enemyImgBuffer[tabId].ids.push(Number(m[1]));
  },
  { urls: ['*://*.akamaized.net/*/enemy_*.js'] }
);

// ── Service Worker 起動ごとにパネル動作を設定（onInstalledだけでは再起動時に漏れる）──
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });

// ── 起動時に既存GBFタブのサイドパネルを有効化 ──
chrome.tabs.query({ url: 'https://game.granbluefantasy.jp/*' }).then((tabs) => {
  for (const tab of tabs) {
    chrome.sidePanel.setOptions({ tabId: tab.id, path: 'sidepanel.html', enabled: true });
  }
});

// ── アイコンクリック → パネルを開く ─
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url?.startsWith(GBF_ORIGIN)) return;

  // sidePanel.open() はユーザージェスチャーの同期スタック内で呼ぶ必要がある
  // await を挟むとジェスチャーコンテキストが失われるため、open を最初に呼ぶ
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) {
    console.error('sidePanel.open failed:', e);
  }
});

// ── GBFページでのみサイドパネルを有効化 ──
chrome.tabs.onUpdated.addListener(async (tabId, _info, tab) => {
  if (!tab.url) return;
  await chrome.sidePanel.setOptions({
    tabId,
    path: 'sidepanel.html',
    enabled: tab.url.startsWith(GBF_ORIGIN),
  });
});

// ── メッセージ中継 ───────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'RAID_LIST_UPDATED') {
    chrome.runtime.sendMessage({ type: 'RAID_LIST_UPDATED', tabId: sender.tab?.id }).catch(() => {});
    return;
  }
  if (message.type === 'RAID_TAB_SWITCHED') {
    chrome.runtime.sendMessage({ type: 'RAID_TAB_SWITCHED', tabId: sender.tab?.id }).catch(() => {});
    return;
  }
  if (message.type === 'START_JSON_COUNT') {
    chrome.runtime.sendMessage({ type: 'START_JSON_COUNT', data: message.data }).catch(() => {});
    return;
  }
  // SELF_HOST_DETECTED / HELL_QUEST_CONSUMED は content.js から sidepanel.js へ直接届くため、
  // ここで再中継すると二重カウント（todayCount +2 等）になる。中継しない。
  // ただし SELF_HOST_DETECTED の敵画像 ID 解決は background で行う。
  if (message.type === 'SELF_HOST_DETECTED') {
    const tabId = sender.tab?.id;
    if (tabId) {
      enemyImgBuffer[tabId] = { questId: message.questId, ids: [] };

      const resolve = () => {
        const buf = enemyImgBuffer[tabId];
        if (!buf || buf.questId !== message.questId) return;
        if (buf.ids.length === 0) { delete enemyImgBuffer[tabId]; return; }
        const mainId = Math.min(...buf.ids);
        const imgUrl = `https://prd-game-a-granbluefantasy.akamaized.net/assets/img_mid/sp/assets/enemy/s/${mainId}.png`;
        delete enemyImgBuffer[tabId];
        // 画像を取得してbase64 data URLとしてキャッシュ
        fetch(imgUrl).then(r => r.blob()).then(blob => {
          const reader = new FileReader();
          reader.onloadend = () => {
            const dataUrl = reader.result;
            // ストレージに永続キャッシュ
            chrome.storage.local.get('gbfRfEnemyImgCache', (data) => {
              const cache = data.gbfRfEnemyImgCache || {};
              cache[message.questId] = dataUrl;
              chrome.storage.local.set({ gbfRfEnemyImgCache: cache });
            });
            // sidepanelに通知（data URLを送信）
            chrome.runtime.sendMessage({
              type: 'ENEMY_IMG_RESOLVED',
              questId: message.questId,
              thumbnailSrc: dataUrl,
            }).catch(() => {});
          };
          reader.readAsDataURL(blob);
        }).catch(() => {
          // fetchに失敗した場合はURL直指定でフォールバック
          chrome.runtime.sendMessage({
            type: 'ENEMY_IMG_RESOLVED',
            questId: message.questId,
            thumbnailSrc: imgUrl,
          }).catch(() => {});
        });
      };

      // Phase 1: 3秒後に試行
      setTimeout(() => {
        const buf = enemyImgBuffer[tabId];
        if (buf && buf.questId === message.questId && buf.ids.length > 0) {
          resolve();
        } else {
          // Phase 2: リロード等で遅延した場合に備え追加7秒待機（計10秒）
          setTimeout(resolve, 7000);
        }
      }, 3000);
    }
    return;
  }
  if (message.type === 'QUEST_META_UPDATED') {
    chrome.runtime.sendMessage({
      type: 'QUEST_META_UPDATED',
      questMeta: message.questMeta,
    }).catch(() => {});
    return;
  }
  if (message.type === 'EVENT_INFO_DETECTED') {
    chrome.runtime.sendMessage({
      type:           'EVENT_INFO_DETECTED',
      eventName:      message.eventName,
      title:          message.title,
      periodText:     message.periodText,
      periodEndMs:    message.periodEndMs,
      hash:           message.hash,
      isTeaser:       !!message.isTeaser,
      isEnding:       !!message.isEnding,
      isRewardClaim:  !!message.isRewardClaim,
      eventStartMs:   Number.isFinite(message.eventStartMs) ? message.eventStartMs : null,
      eventEndMs:     Number.isFinite(message.eventEndMs)   ? message.eventEndMs   : null,
    }).catch(() => {});
    return;
  }
  // ── mypage グローバルバナー画像の base64 化 ──
  // sidepanel が「未キャッシュ時のみ」依頼する EVENT_BANNER_FETCH を受けて取得する。
  // （EVENT_BANNER_DETECTED は sidepanel が直接受信するため、ここでは中継も自動 fetch もしない）
  if (message.type === 'EVENT_BANNER_FETCH') {
    const path   = message.path;
    const imgUrl = message.imgUrl;
    if (!path || !imgUrl) return;
    fetch(imgUrl).then(r => r.blob()).then(blob => {
      const reader = new FileReader();
      reader.onloadend = () => {
        chrome.runtime.sendMessage({
          type:      'EVENT_BANNER_RESOLVED',
          path,
          imgUrl,
          bannerSrc: reader.result,
        }).catch(() => {});
      };
      reader.readAsDataURL(blob);
    }).catch(() => {
      // 失敗時は空 bannerSrc を返して pending 解除（URL 表示にフォールバック・次回再試行可）
      chrome.runtime.sendMessage({
        type:      'EVENT_BANNER_RESOLVED',
        path,
        imgUrl,
        bannerSrc: '',
      }).catch(() => {});
    });
    return;
  }
});
