import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, AudioLines, CircleHelp, Home as HomeIcon, X } from 'lucide-react';
import { Home } from './components/Home';
import { Workspace } from './components/Workspace';
import { useInterview } from './hooks/useInterview';
import { DEFAULT_SETTINGS } from './lib/session';
import { createLocalTranslator, getTranslationAvailability } from './lib/translator';
import { connectGateway } from './lib/ai';
import type { Settings } from './types';

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [page, setPage] = useState<'home' | 'workspace'>('home');
  const [localStatus, setLocalStatus] = useState('正在檢查瀏覽器支援…');
  const [progress, setProgress] = useState(0), [preparing, setPreparing] = useState(false);
  const [starting, setStarting] = useState(false), [connecting, setConnecting] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState('');
  const [startError, setStartError] = useState('');
  const [localPreparationFailed, setLocalPreparationFailed] = useState(false);
  const local = useRef<Awaited<ReturnType<typeof createLocalTranslator>> | null>(null);
  const preparingRef = useRef<Promise<Awaited<ReturnType<typeof createLocalTranslator>> | null> | null>(null);
  const helpDialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  const connectionGeneration = useRef(0);
  const connectionAbort = useRef<AbortController | null>(null);
  const session = useInterview();
  const locked = session.hasSession && !session.ended;
  useEffect(() => {
    let live = true;
    void getTranslationAvailability().then(status => { if (live) setLocalStatus(status === 'available' ? '瀏覽器支援，可準備本機翻譯' : status === 'downloadable' || status === 'downloading' ? '支援本機翻譯，首次使用需下載模型' : '此瀏覽器尚不支援；可使用英文字幕或手動選擇雲端翻譯'); }).catch(() => { if (live) setLocalStatus('無法確認支援狀態，可按「準備翻譯」重試'); });
    return () => { live = false; mounted.current = false; local.current?.destroy(); connectionAbort.current?.abort(); };
  }, []);
  async function prepare() {
    if (local.current) return local.current;
    if (preparingRef.current) return preparingRef.current;
    setPreparing(true); setProgress(0); setLocalPreparationFailed(false); setStartError('');
    const task = createLocalTranslator(value => { if (mounted.current) setProgress(value); }).then(translator => {
      if (!mounted.current) { translator.destroy(); return null; }
      local.current = translator; setLocalStatus('本機翻譯已就緒 · 無翻譯 API 費'); setProgress(1); return translator;
    }).catch((e: unknown) => { if (mounted.current) { setLocalStatus(e instanceof Error ? e.message : '本機翻譯準備失敗，請重試或選擇其他字幕方式。'); setLocalPreparationFailed(true); } return null; }).finally(() => { if (mounted.current) setPreparing(false); preparingRef.current = null; });
    preparingRef.current = task; return task;
  }
  async function begin(demo: boolean) {
    if (starting) return;
    setStartError('');
    if (!demo && settings.translationMode === 'cloud') {
      let message = '', field = '';
      if (settings.connectionMode === 'personal') {
        if (!settings.apiKey.trim() || settings.apiKey.length > 1024) {
          message = '雲端翻譯需要有效的 API 金鑰。請填寫 API 金鑰後再開始。'; field = 'api-key';
        }
      } else if (!settings.sessionToken.trim() || settings.sessionToken.length > 2048) {
        message = '請先連線安全代理，取得有效連線後再開始雲端翻譯。';
        field = !settings.gatewayUrl.trim() ? 'gateway-url' : !settings.accessCode.trim() ? 'gateway-access-code' : 'gateway-connect';
      } else {
        try {
          const url = new URL(settings.gatewayUrl.trim());
          if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
        } catch { message = '代理網址須為完整 HTTPS 網址，且不可含帳密、查詢參數或片段。'; field = 'gateway-url'; }
      }
      if (message) { setStartError(message); document.getElementById(field)?.focus(); return; }
    }
    setStarting(true);
    try {
      let translator = local.current;
      if (!demo && settings.translationMode === 'local' && !translator) translator = await prepare();
      if (!mounted.current) return;
      if (!demo && settings.translationMode === 'local' && !translator) {
        setStartError('本機翻譯尚未就緒，尚未開始收音。請重試準備，或選擇其他字幕方式後再開始。'); return;
      }
      session.start(settings, demo, translator); setPage('workspace'); window.scrollTo({ top: 0 });
    } finally { if (mounted.current) setStarting(false); }
  }
  async function connect() {
    connectionAbort.current?.abort();
    const controller = new AbortController(); connectionAbort.current = controller;
    const gen = ++connectionGeneration.current;
    setConnecting(true); setConnectionMessage('');
    try { const result = await connectGateway(settings, controller.signal); if (!mounted.current || gen !== connectionGeneration.current) return; setSettings(current => ({ ...current, sessionToken: result.token, provider: 'openai' })); if (session.sessionSettings?.connectionMode === 'gateway' && session.sessionSettings.gatewayUrl === settings.gatewayUrl) session.updateConnection({ apiKey: settings.apiKey, accessCode: settings.accessCode, sessionToken: result.token }); if (settings.translationMode === 'cloud') setStartError(''); setConnectionMessage('安全代理已連線，可以開始訪談。'); }
    catch (e) { if (mounted.current && gen === connectionGeneration.current) setConnectionMessage(e instanceof Error ? e.message : '連線失敗，請檢查代理網址與存取碼。'); }
    finally { if (mounted.current && gen === connectionGeneration.current) setConnecting(false); }
  }
  function updateSettings(next: Settings) {
    connectionGeneration.current++; connectionAbort.current?.abort(); setConnecting(false);
    const normalized = { ...next, provider: next.connectionMode === 'gateway' ? 'openai' as const : next.provider };
    setSettings(normalized); setConnectionMessage(''); setStartError('');
    const currentSession = session.sessionSettings;
    if (currentSession && currentSession.provider === normalized.provider && currentSession.connectionMode === normalized.connectionMode && currentSession.gatewayUrl === normalized.gatewayUrl) session.updateConnection({ apiKey: normalized.apiKey, sessionToken: normalized.sessionToken, accessCode: normalized.accessCode });
  }
  function goHome() { if (session.hasSession && !session.ended) session.pause(); setPage('home'); window.scrollTo({ top: 0 }); }
  return <div className="app-shell">
    <aside className="sidebar"><a className="brand" href="#" aria-label="AOA 首頁" onClick={e => { e.preventDefault(); goHome(); }}><svg viewBox="0 0 44 44" aria-hidden="true"><path d="m6 32 8-21 8 21m-13-6h10m3 6 8-21 8 21m-13-6h10"/></svg></a><nav aria-label="主要導覽"><button className={`nav-item ${page === 'home' ? 'active' : ''}`} onClick={goHome} aria-current={page === 'home' ? 'page' : undefined}><HomeIcon size={22}/><span>開始</span></button><button className={`nav-item ${page === 'workspace' ? 'active' : ''}`} disabled={!session.hasSession} onClick={() => setPage('workspace')} aria-current={page === 'workspace' ? 'page' : undefined}><AudioLines size={22}/><span>訪談</span></button></nav><button aria-label="使用說明" className="nav-item help-trigger" onClick={() => helpDialog.current?.showModal()}><CircleHelp size={22}/><span>使用說明</span></button></aside>
    <main className="main-content"><div className="topbar"><span className="wordmark">AOA <span>/ INTERVIEW WORKSPACE</span></span><a href="https://github.com/YMUNick/AOA" target="_blank" rel="noopener noreferrer" className="source-link">開源專案 <ArrowUpRight size={13}/></a></div>{page === 'home' ? <Home settings={settings} setSettings={updateSettings} onStart={begin} onPrepare={() => { void prepare(); }} localStatus={localStatus} progress={progress} preparing={preparing} starting={starting} onConnect={connect} connecting={connecting} connectionMessage={connectionMessage} startError={startError} localPreparationFailed={localPreparationFailed} locked={locked} onReturn={() => setPage('workspace')}/> : <Workspace session={session} onSettings={goHome}/> }<div className="app-footer">AOA · 讓理解與表達，保持在同一頁。<span>你的聲音，不會被這個網站錄製或保存。</span></div></main>
    <dialog ref={helpDialog} className="help-dialog"><div className="dialog-heading"><h2>讓面試更從容</h2><button className="icon-button" aria-label="關閉使用說明" onClick={() => helpDialog.current?.close()}><X size={22}/></button></div><div className="help-copy"><h3>1. 先準備，再開始</h3><p>建議使用新版桌面 Chrome 與系統預設麥克風。選擇本機翻譯時，第一次需要下載語言模型。瀏覽器語音辨識可能透過雲端處理，必須保持網路連線。</p><h3>2. 選取問題，才產生回答</h3><p>反白英文或中文，或按每段的「選取整段」。再按「產生回答」才會使用 AI。英文背景可幫助回答更貼近實際經驗；不要把範例當作自己的經歷。</p><h3>3. 金鑰與費用</h3><p>個人模式的 API 金鑰只保留在這個分頁記憶體中。重新整理會清除金鑰和內容。瀏覽器頁面程式仍可接觸金鑰，正式使用可部署自己的安全代理。API 費用與 ChatGPT 訂閱分開。</p><p>費用以模型回傳的 token 用量估算。失敗或取消的請求仍可能被計費，因此會保留預估用量；網頁預算不是供應商帳戶的帳單硬上限。</p><h3>4. 把重要的內容帶走</h3><p>結束後按「匯出」，下載雙語文字與最近一次回答。開始新訪談或重新整理會清除這個分頁內的紀錄。請在面試前用你的裝置試聽；長時間辨識可能需要重新連線。</p><div className="help-links"><a href="https://github.com/YMUNick/AOA#readme" target="_blank" rel="noopener noreferrer">部署與使用文件 <ArrowUpRight size={14}/></a><a href="https://developers.openai.com/api/docs/models/gpt-6-luna" target="_blank" rel="noopener noreferrer">OpenAI 牌價 <ArrowUpRight size={14}/></a><a href="https://ai.google.dev/gemini-api/docs/pricing" target="_blank" rel="noopener noreferrer">Gemini 牌價 <ArrowUpRight size={14}/></a></div><small>估算單價更新：2026-10-14。模型可用性及價格以供應商為準。</small></div></dialog>
  </div>;
}
