import { ArrowRight, AudioLines, Check, ChevronDown, Eye, EyeOff, Globe2, KeyRound, LoaderCircle, Mic, Monitor, Play, ShieldCheck, Sparkles, Wallet } from 'lucide-react';
import { useState } from 'react';
import type { Settings } from '../types';
import { estimateHourlyCost } from '../lib/budget';
import { formatMoney } from '../lib/session';

interface Props {
  settings: Settings; setSettings: (s: Settings) => void; onStart: (demo: boolean) => void;
  onPrepare: () => void; localStatus: string; progress: number; preparing: boolean; starting: boolean;
  onConnect: () => void; connecting: boolean; connectionMessage: string; locked: boolean; onReturn: () => void;
  startError: string; localPreparationFailed: boolean; localUnavailable: boolean;
  tabAudioAvailability: { supported: boolean; reason: string };
}
export function Home(p: Props) {
  const { settings: s } = p;
  const [showKey, setShowKey] = useState(false);
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => p.setSettings({ ...s, [key]: value, ...(key === 'gatewayUrl' || key === 'accessCode' ? { sessionToken: '' } : {}) });
  const estimate = estimateHourlyCost(s.provider, s.expectedAnswers, s.translationMode === 'cloud');
  return <div className="home-page">
    <header className="page-heading"><div className="eyebrow">YOUR INTERVIEW, IN FOCUS</div><h1>把注意力留給對話<span className="cyan">。</span></h1><p>即時理解英文問題，再用你的經驗回答。</p></header>
    {p.locked && <div className="notice"><ShieldCheck size={18}/><span>本次收音來源、模型、翻譯與預算已固定；更新金鑰不會更改翻譯方式。若要更改翻譯方式或收音來源，請先結束本次訪談，再開始新訪談。目前逐字稿仍保留，可更新金鑰或重新連線。</span><button className="text-button" onClick={p.onReturn}>返回工作區 <ArrowRight size={16}/></button></div>}
    <div className="setup-grid">
      <section className="panel setup-panel" aria-labelledby="setup-title">
        <div className="panel-intro"><h2 id="setup-title">開始前，先設定好</h2><p>你的收音方式、翻譯偏好與 AI 回答助手。</p></div>
        <fieldset disabled={p.starting}>
          <div className="section-title"><span className="step-number">1</span><h3>收音與語言</h3></div>
          <div className="field-grid">
            <label className="field">收音來源<select disabled={p.locked} value={s.audioSource} onChange={e => set('audioSource', e.target.value as Settings['audioSource'])}><option value="microphone">麥克風 · 現場對話</option><option value="tab">會議分頁音訊 · 電腦 Chrome</option></select></label>
            <div className="field"><span className="field-label">辨識語言 → 翻譯語言</span><div className="static-field language-pair"><span>English</span><ArrowRight size={19}/><span>繁體中文</span></div></div>
          </div>
          {s.audioSource === 'tab' ? <><p className="field-hint">Chrome 分頁 → 選取 Google Meet → 勾選「分享分頁音訊」→ 分享</p><p className="field-hint">可戴耳機使用。瀏覽器會一併要求分頁畫面權限；AOA 不讀取或錄製畫面。音訊最多在此分頁記憶體暫存 30 秒，辨識可能經由瀏覽器雲端服務處理。</p>{!p.tabAudioAvailability.supported && <p className="field-hint" role="status">{p.tabAudioAvailability.reason}</p>}</> : <p className="field-hint">按下開始後才會要求麥克風權限；語音辨識可能經由瀏覽器雲端服務處理。</p>}
          <div className="translation-box">
            <div className="translation-title"><Globe2 size={19}/><label htmlFor="translation">翻譯方式</label><span className="mini-badge">省費優先</span></div>
            <div className="translation-control"><select id="translation" disabled={p.locked} value={s.translationMode} onChange={e => set('translationMode', e.target.value as Settings['translationMode'])}><option value="local">本機翻譯 · 無翻譯 API 費</option><option value="cloud">雲端翻譯 · 會使用付費 API</option><option value="off">只顯示英文字幕</option></select></div>
            <p className="field-hint">會記住收音來源、翻譯方式、AI 服務與連線方式；API 金鑰只保留於此分頁，重新整理後需重填。</p>
            {s.translationMode === 'local' && <div className="local-preparation"><span role="status">{p.preparing ? `正在準備語言模型 ${Math.round(p.progress * 100)}%` : p.localStatus}</span><button type="button" className="text-button" disabled={p.preparing || p.locked} onClick={p.onPrepare}>{p.preparing ? <LoaderCircle className="spin" size={15}/> : <Monitor size={15}/>}準備翻譯</button></div>}
            {s.translationMode === 'local' && <p className="field-hint">本機翻譯準備完成後才會顯示中文。若裝置不支援，可手動選擇付費雲端翻譯並設定 AI 連線。</p>}
            {s.translationMode === 'local' && (p.localUnavailable || p.localPreparationFailed) && !p.locked && <div className="translation-fallback-actions"><button type="button" className="button secondary" onClick={() => set('translationMode', 'cloud')}>改用雲端翻譯（計費）</button><button type="button" className="button secondary" onClick={() => set('translationMode', 'off')}>只用英文字幕</button></div>}
            {s.translationMode === 'cloud' && <p className="field-hint">沿用下方已選 AI 服務的 API 金鑰或代理連線。每段加入逐字稿的英文（含未確認的句尾）會自動送出翻譯並計費。</p>}
            {s.translationMode === 'off' && <p className="field-hint">中文未啟用，只顯示英文字幕。需要中文時，請在開始新訪談前選擇可用的翻譯方式。</p>}
            {p.preparing && <progress max="1" value={p.progress} aria-label="翻譯模型下載進度"/>}
          </div>
          <div className="section-title ai-title"><span className="step-number">2</span><h3>AI 回答助手</h3></div>
          <div className="field-grid connection-fields">
            <label className="field">連線方式<select disabled={p.locked} value={s.connectionMode} onChange={e => set('connectionMode', e.target.value as Settings['connectionMode'])}><option value="personal">個人金鑰 · 僅本次使用</option><option value="gateway">安全代理 · 建議正式使用</option></select></label>
            <label className="field">AI 服務<select value={s.provider} disabled={p.locked || s.connectionMode === 'gateway'} onChange={e => set('provider', e.target.value as Settings['provider'])}><option value="openai">OpenAI · 省費模式</option>{s.connectionMode === 'personal' && <option value="gemini">Gemini · Flash-Lite</option>}</select></label>
          </div>
          {s.connectionMode === 'personal' ? <>
            <label className="field key-field" htmlFor="api-key">{s.provider === 'openai' ? 'OpenAI' : 'Gemini'} API 金鑰<div className="password-field"><KeyRound size={17}/><input id="api-key" type={showKey ? 'text' : 'password'} value={s.apiKey} placeholder="貼上你的 API key，僅保留於此分頁" autoComplete="off" spellCheck={false} onChange={e => set('apiKey', e.target.value)}/><button type="button" className="icon-button" aria-label={showKey ? '隱藏金鑰' : '顯示金鑰'} aria-pressed={showKey} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={18}/> : <Eye size={18}/>}</button></div></label>
            <p className="field-hint security-note"><ShieldCheck size={15}/><span>金鑰不會存入網站或瀏覽器儲存空間。個人模式的頁面程式仍可讀取金鑰；正式使用建議安全代理。</span></p>
          </> : <>
            <label className="field">代理服務位址<input id="gateway-url" type="url" disabled={p.locked} placeholder="https://your-worker.workers.dev" value={s.gatewayUrl} onChange={e => set('gatewayUrl', e.target.value)} spellCheck={false}/></label>
            <div className="field-grid gateway-auth"><label className="field">私人存取碼<input id="gateway-access-code" type="password" value={s.accessCode} autoComplete="off" placeholder="由你設定的代理存取碼" onChange={e => set('accessCode', e.target.value)}/></label><button id="gateway-connect" className="button secondary connect-button" type="button" disabled={p.connecting || !s.gatewayUrl || !s.accessCode} onClick={p.onConnect}>{p.connecting ? <LoaderCircle className="spin" size={16}/> : s.sessionToken ? <Check size={16}/> : <ShieldCheck size={16}/>} {s.sessionToken ? '重新連線' : '連線代理'}</button></div>
            <p className="field-hint">需先部署自己的代理。供應商金鑰留在伺服器端，連線本身不呼叫模型。</p>
          </>}
          {p.connectionMessage && <p className="connection-result" role="status">{p.connectionMessage}</p>}
          <details className="profile-details"><summary><span><Sparkles size={17}/>加入個人背景 <small>選填，讓建議更貼近你的經驗</small></span><ChevronDown size={18}/></summary><label className="field">應徵職位、真實經歷與擅長的能力<textarea disabled={p.locked} rows={4} maxLength={1800} value={s.profile} placeholder="例如：應徵產品經理，曾協調工程與設計團隊完成專案。只填真實經驗，不必貼完整履歷。" onChange={e => set('profile', e.target.value)}/></label><p className="field-hint">僅在你產生回答時送出，重新整理後清除。{s.profile.length} / 1,800</p></details>
        </fieldset>
      </section>
      <aside className="setup-aside">
        <section className="panel ready-panel"><h2>準備好，從容開始</h2><p className="subtle">一個畫面，跟上問題與回答。</p>
          <ol className="flow-list"><li><span className="flow-icon"><Mic size={20}/></span><div><strong>聽懂當下</strong><p>英文即時字幕，翻譯就緒後搭配繁體中文</p></div></li><li><span className="flow-icon"><AudioLines size={20}/></span><div><strong>選取問題</strong><p>反白文字，或直接選取整段</p></div></li><li><span className="flow-icon violet"><Sparkles size={20}/></span><div><strong>整理成你的回答</strong><p>英文建議搭配中文思路</p></div></li></ol>
          <div className="budget-settings"><h3><Wallet size={17}/>費用有數，回答有底</h3><fieldset disabled={p.locked || p.starting}>
            <label className="field">本次預算上限（USD）<div className="money-input"><span>US$</span><input type="number" min="0.01" max="20" step="0.1" value={s.budgetUsd} onChange={e => set('budgetUsd', Number(e.target.value))}/></div></label>
            <label className="field answers-count">預計每小時回答次數<select value={s.expectedAnswers} onChange={e => set('expectedAnswers', Number(e.target.value))}>{[10, 20, 40].map(n => <option value={n} key={n}>{n} 次 · 精簡回答</option>)}</select></label>
          </fieldset><div className="hour-estimate"><span>一小時模型費估算</span><strong>{formatMoney(estimate.low)}{estimate.high !== estimate.low && ` – ${formatMoney(estimate.high)}`}</strong></div><p className="field-hint">含 20% 餘裕；不含另購語音與代理服務。依實際 token 計費，非帳單保證。</p><p className="field-hint">接近預算時提醒，達上限停止新付費請求。</p></div>
        </section>
        {p.startError && <div className="notice error" role="alert">{p.startError}</div>}
        <button className="button primary start-button" disabled={p.starting || (!p.locked && (!Number.isFinite(s.budgetUsd) || s.budgetUsd < 0.01 || s.budgetUsd > 20 || (s.audioSource === 'tab' && !p.tabAudioAvailability.supported)))} onClick={() => p.locked ? p.onReturn() : p.onStart(false)}>{p.starting ? <LoaderCircle size={20} className="spin"/> : s.audioSource === 'tab' ? <Monitor size={20}/> : <Mic size={20}/>}<span>{p.starting ? '正在準備…' : p.locked ? '返回本次訪談' : s.audioSource === 'tab' ? '選擇會議分頁並開始' : '開始聆聽'}</span><ArrowRight size={21}/></button>
        {!p.locked && <button className="button demo-button" disabled={p.starting} onClick={() => p.onStart(true)}><Play size={16}/>先試用示範 · 不收音、不計費</button>}
        <p className="start-note">{s.audioSource === 'tab' ? '電腦 Chrome · 音訊僅於分頁暫存' : '桌面 Chrome 體驗最佳 · 不儲存錄音'}</p>
      </aside>
    </div>
  </div>;
}
