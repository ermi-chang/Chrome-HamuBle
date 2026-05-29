// 機能追加時のルール:
// 1. ja / en / zh の 3 セクション全てにキーを追加する
// 2. HTML 静的テキスト → data-i18n="key" 属性を使う
// 3. JS 動的テキスト   → t('key') または t('key', { param: val }) を使う
// 4. 直接文字列ハードコードは禁止

const TRANSLATIONS = {
  ja: {
    // Navigation
    navHomeDefault:  '現在のGBFページURLをコピーして\nホームボタン設定画面を開きます',
    navHomeNoGbf:    '⚠ GBFを開いてください',
    navHomeCopied:   '✅ URLコピー済 — chrome://settings/appearance で貼り付け',
    navRescue:       '救援フィルタ',
    navHostHistory:  'マイクエスト',
    navInfo:         '情報（使い方・安全性・免責事項）',
    navSettings:     '設定',
    // Settings panel
    settingsTitle:        '⚙ 詳細設定',
    settingsSidebarPos:   'サイドバー位置',
    settingsSidebarLeft:  'アイコン 左',
    settingsSidebarRight: 'お気に入り 左',
    settingsLang:         '言語',
    settingsHostCols:     'マイクエストカラム数',
    settingsHideDepleted: '完了したクエストを非表示',
    // Rescue section
    rescueSectionTitle: '救援マルチ',
    rescueBtnAssist:    '⚔ 救援依頼一覧',
    rescueBtnUnconf:    '⚔ 未確認バトル',
    // Filters
    filterMem:                 '人数',
    filterAbove:               '以上',
    filterBelow:               '以下',
    filterFp:                  'FP 対象限定',
    filterSaveBtn:             '＋保存',
    filterSaveBtnConfirm:      '保存',
    filterCancel:              '✕',
    filterTemplatePlaceholder: 'テンプレート名を入力...',
    filterPercent:             '%',
    filterPeople:              '人',
    // Sort
    sortLabel:   '並び順',
    sortDefault: 'デフォルト',
    sortHpAsc:   'HP 低い順',
    sortHpDesc:  'HP 高い順',
    sortMemAsc:  '人数 少ない順',
    sortMemDesc: '人数 多い順',
    sortTimeAsc: '残り時間 短い順',
    // Count / status
    countUnit:  '件',
    countEmpty: '— 件',
    bpLabel:    'BP:',
    // Messages
    msgLoading:    '読み込み中...',
    msgNoGbf:      'ゲームページが見つかりません<br>グランブルーファンタジーを開いてください',
    msgNoResponse: '応答なし',
    msgError:      'エラー: {msg}<br>ページを再読み込みしてください',
    msgNoRaids:    'マルチバトルが見つかりません<br>救援検索タブを開いてから<br>「更新」を押してください',
    msgNoFilter:   'フィルター条件に一致する<br>マルチバトルがありません',
    // Raid card
    raidMkMem:        '人数',
    raidTitleUnknown: '未知のクラス（{cls}）のため参加不可',
    raidUnknownWarn:  '⚠ 未知クラス: {cls}',
    raidClickJoin:    'クリックして参加',
    // Host history
    hostTitle:              'マイクエスト',
    hostDelTitle:           '削除',
    hostClearTitle:         '削除',
    hostNoQuests:           'クエストがまだ登録されていません',
    hostNoCatQuests:        'このカテゴリのクエストはありません',
    hostRemainingPre:       '残り ',
    hostRemainingPost:      ' 回',
    hostTodayCountSuffix:   '回',
    hostHellSkipOptSuffix:  '回',
    // Category chip labels (HTML buttons)
    catEvent: 'イベント',
    catFree:  'フリー',
    catOther: 'その他',
    // Category group headers (JS renderHostHistory)
    catLabelEvent: 'イベント',
    catLabelFree:  'フリー',
    catLabelOther: 'その他',
    // BP warning
    bpWarning: '⚠ BP 不足です。本体パネル側で BP を回復させてください。',
    // Version
    versionLabel: 'HamuBle v{v}',
    // Template chip delete
    templateDeleteTitle: '削除',
    // Confirm dialogs
    confirmClearAll: 'マイクエスト（{count}件）をすべて削除しますか？',
    confirmClearCat: '現在のカテゴリのクエスト {count}件 を削除しますか？',
  },

  en: {
    // Navigation
    navHomeDefault:  'Copy current GBF page URL\nand open Home button settings',
    navHomeNoGbf:    '⚠ Please open GBF first',
    navHomeCopied:   '✅ URL copied — paste at chrome://settings/appearance',
    navRescue:       'Raid Filter',
    navHostHistory:  'My Quests',
    navInfo:         'Info (Usage / Safety / Disclaimer)',
    navSettings:     'Settings',
    // Settings panel
    settingsTitle:        '⚙ Settings',
    settingsSidebarPos:   'Sidebar position',
    settingsSidebarLeft:  'Icon Left',
    settingsSidebarRight: 'Fav Left',
    settingsLang:         'Language',
    settingsHostCols:     'My Quests columns',
    settingsHideDepleted: 'Hide completed quests',
    // Rescue section
    rescueSectionTitle: 'Raid Multi',
    rescueBtnAssist:    '⚔ Raid List',
    rescueBtnUnconf:    '⚔ Unconfirmed Battles',
    // Filters
    filterMem:                 'Members',
    filterAbove:               'or more',
    filterBelow:               'or less',
    filterFp:                  'FP eligible only',
    filterSaveBtn:             '＋Save',
    filterSaveBtnConfirm:      'Save',
    filterCancel:              '✕',
    filterTemplatePlaceholder: 'Enter template name...',
    filterPercent:             '%',
    filterPeople:              'p',
    // Sort
    sortLabel:   'Sort',
    sortDefault: 'Default',
    sortHpAsc:   'HP: Low → High',
    sortHpDesc:  'HP: High → Low',
    sortMemAsc:  'Members: Fewest',
    sortMemDesc: 'Members: Most',
    sortTimeAsc: 'Time: Shortest',
    // Count / status
    countUnit:  'entries',
    countEmpty: '— entries',
    bpLabel:    'BP:',
    // Messages
    msgLoading:    'Loading...',
    msgNoGbf:      'Game page not found<br>Please open GranBlue Fantasy',
    msgNoResponse: 'No response',
    msgError:      'Error: {msg}<br>Please reload the page',
    msgNoRaids:    'No multi battles found<br>Open the raid search tab<br>and press Refresh',
    msgNoFilter:   'No multi battles match<br>the current filter',
    // Raid card
    raidMkMem:        'Members',
    raidTitleUnknown: 'Unknown class ({cls}) — cannot join',
    raidUnknownWarn:  '⚠ Unknown class: {cls}',
    raidClickJoin:    'Click to join',
    // Host history
    hostTitle:             'My Quests',
    hostDelTitle:          'Delete',
    hostClearTitle:        'Delete',
    hostNoQuests:          'No quests registered yet',
    hostNoCatQuests:       'No quests in this category',
    hostRemainingPre:      '',
    hostRemainingPost:     ' remaining',
    hostTodayCountSuffix:  '×',
    hostHellSkipOptSuffix: '×',
    // Category chip labels
    catEvent: 'Event',
    catFree:  'Free',
    catOther: 'Other',
    // Category group headers
    catLabelEvent: 'EVENT',
    catLabelFree:  'FREE',
    catLabelOther: 'OTHER',
    // BP warning
    bpWarning: '⚠ BP insufficient. Please restore BP in the main panel.',
    // Version
    versionLabel: 'HamuBle v{v}',
    // Template chip delete
    templateDeleteTitle: 'Delete',
    // Confirm dialogs
    confirmClearAll: 'Delete all My Quests ({count} entries)?',
    confirmClearCat: 'Delete {count} quests in this category?',
  },

  zh: {
    // Navigation
    navHomeDefault:  '复制当前GBF页面URL\n并打开主页按钮设置页面',
    navHomeNoGbf:    '⚠ 请先打开GBF',
    navHomeCopied:   '✅ URL已复制 — 粘贴到 chrome://settings/appearance',
    navRescue:       '救援筛选',
    navHostHistory:  '我的任务',
    navInfo:         '信息（使用说明·安全·免责声明）',
    navSettings:     '设置',
    // Settings panel
    settingsTitle:        '⚙ 详细设置',
    settingsSidebarPos:   '侧边栏位置',
    settingsSidebarLeft:  '图标 左',
    settingsSidebarRight: '收藏 左',
    settingsLang:         '语言',
    settingsHostCols:     '我的任务列数',
    settingsHideDepleted: '隐藏已完成的任务',
    settingsShowEventBanner: '活动横幅',
    // Rescue section
    rescueSectionTitle: '救援多人战',
    rescueBtnAssist:    '⚔ 救援请求列表',
    rescueBtnUnconf:    '⚔ 未确认战斗',
    // Filters
    filterMem:                 '人数',
    filterAbove:               '以上',
    filterBelow:               '以下',
    filterFp:                  '仅限FP对象',
    filterSaveBtn:             '＋保存',
    filterSaveBtnConfirm:      '保存',
    filterCancel:              '✕',
    filterTemplatePlaceholder: '输入模板名称...',
    filterPercent:             '%',
    filterPeople:              '人',
    // Sort
    sortLabel:   '排序',
    sortDefault: '默认',
    sortHpAsc:   'HP 从低到高',
    sortHpDesc:  'HP 从高到低',
    sortMemAsc:  '人数 从少到多',
    sortMemDesc: '人数 从多到少',
    sortTimeAsc: '剩余时间 从短到长',
    // Count / status
    countUnit:  '条',
    countEmpty: '— 条',
    bpLabel:    'BP:',
    // Messages
    msgLoading:    '加载中...',
    msgNoGbf:      '未找到游戏页面<br>请打开碧蓝幻想',
    msgNoResponse: '无响应',
    msgError:      '错误: {msg}<br>请重新加载页面',
    msgNoRaids:    '未找到多人战<br>请打开救援搜索标签<br>后点击"刷新"',
    msgNoFilter:   '没有符合筛选条件的<br>多人战',
    // Raid card
    raidMkMem:        '人数',
    raidTitleUnknown: '未知职业（{cls}），无法参加',
    raidUnknownWarn:  '⚠ 未知职业: {cls}',
    raidClickJoin:    '点击参加',
    // Host history
    hostTitle:             '我的任务',
    hostDelTitle:          '删除',
    hostClearTitle:        '删除',
    hostNoQuests:          '尚未登记任何任务',
    hostNoCatQuests:       '该分类暂无任务',
    hostRemainingPre:      '剩余 ',
    hostRemainingPost:     ' 次',
    hostTodayCountSuffix:  '次',
    hostHellSkipOptSuffix: '次',
    // Category chip labels
    catEvent: '活动',
    catFree:  '自由',
    catOther: '其他',
    // Category group headers
    catLabelEvent: '活动',
    catLabelFree:  '自由',
    catLabelOther: '其他',
    // Event banner section headers (开催予告 / 开催中 / 开催终了)
    eventGroupTeaser: '活动预告',
    eventGroupActive: '举办中',
    eventGroupEnded:  '已结束',
    // BP warning
    bpWarning: '⚠ BP不足，请在主面板中恢复BP。',
    // Support hint (info footer)
    supportHint: '如果您喜欢，欢迎支持 ♡',
    // Version
    versionLabel: 'HamuBle v{v}',
    // Template chip delete
    templateDeleteTitle: '删除',
    // Confirm dialogs
    confirmClearAll: '确定删除全部我的任务（{count}条）吗？',
    confirmClearCat: '确定删除当前分类的 {count} 条任务吗？',
    // Favorites bar
    favEmpty:             '（空）',
    favEditTitle:         '重命名',
    favRenamePlaceholder: '输入名称...',
  },
};

let _lang = 'ja';

function t(key, params) {
  let str = TRANSLATIONS[_lang]?.[key] ?? TRANSLATIONS.ja[key] ?? key;
  if (params) {
    Object.entries(params).forEach(([k, v]) => { str = str.replace(`{${k}}`, v); });
  }
  return str;
}

function applyI18n(lang) {
  _lang = lang;
  const langAttr = lang === 'zh' ? 'zh-Hans' : lang;
  document.documentElement.lang = langAttr;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.dataset.i18nTitle);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
}
