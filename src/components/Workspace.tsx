import { ArrowDown, ArrowLeft, Check, Copy, Download, FileText, LoaderCircle, Mic, Pause, Play, RotateCcw, Send, Settings2, Sparkles, Square, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { useInterview } from '../hooks/useInterview';
import { useTranscriptSelection } from '../hooks/useTranscriptSelection';
import { exportTranscript, formatMoney, formatTime } from '../lib/session';
import type { TranscriptSegment } from '../types';
import { requestTabAudio, type TabAudioCapture } from '../lib/tabAudio';

type Interview = ReturnType<typeof useInterview>;
export function Workspace({ session: s, onSettings }: { session: Interview; onSettings: () => void }) {
  const [manual, setManual] = useState(false), [manualText, setManualText] = useState('');
  const [tab, setTab] = useState<'transcript' | 'answer'>('transcript');
  const [follow, setFollow] = useState(true), [copied, setCopied] = useState(false);
  const [choosingSource, setChoosingSource] = useState(false), [sourceError, setSourceError] = useState('');
  const sourceGeneration = useRef(0), pendingCapture = useRef<TabAudioCapture | null>(null);
  const scroll = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const following = useRef(true), lastScrollTop = useRef(0);
  const readSelection = useTranscriptSelection(scroll, { onSelect: text => s.select(text), onSelectionStart: holdReading });
  const tabAudio = s.sessionSettings?.audioSource === 'tab' && !s.isDemo;
  const busy = s.finishing || choosingSource;
  const status = s.isDemo ? '示範模式' : s.finishing ? '正在收尾' : choosingSource ? '等待選擇分頁' : ({ idle: '尚未開始', requesting: tabAudio ? '正在連接會議音訊' : '等待麥克風權限', listening: tabAudio ? '正在接收會議音訊' : '聆聽中', reconnecting: '正在重新連線', paused: '已暫停', stopped: '已結束', error: '需要處理' }[s.speechState]);
  const spend = s.usage.spent + s.usage.reserved, budget = s.sessionSettings?.budgetUsd || .5;
  useEffect(() => () => { sourceGeneration.current++; pendingCapture.current?.close(); pendingCapture.current = null; }, []);
  useEffect(() => {
    if (!content.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (following.current && !hasTranscriptSelection()) scrollToLatest();
    });
    observer.observe(content.current);
    if (scroll.current) observer.observe(scroll.current);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (following.current && !hasTranscriptSelection()) scrollToLatest();
  }, [s.segments, s.interim, follow, tab]);
  function hasTranscriptSelection() {
    const selection = window.getSelection();
    return !!selection && !selection.isCollapsed && !!scroll.current &&
      (scroll.current.contains(selection.anchorNode) || scroll.current.contains(selection.focusNode));
  }
  function setFollowing(value: boolean) { following.current = value; setFollow(value); }
  function scrollToLatest() {
    const element = scroll.current;
    if (!element || !element.clientHeight) return;
    const bottom = Math.max(0, element.scrollHeight - element.clientHeight);
    // Record our destination first so its scroll event cannot be mistaken for reading.
    lastScrollTop.current = bottom;
    element.scrollTo({ top: bottom, behavior: 'instant' });
  }
  function onTranscriptScroll() {
    const element = scroll.current;
    if (!element || !element.clientHeight) return;
    const top = Math.max(0, element.scrollTop), previous = lastScrollTop.current;
    lastScrollTop.current = top;
    if (top < previous - 1) setFollowing(false);
    else if (top > previous + 1 && element.scrollHeight - element.clientHeight - top <= 12 && !hasTranscriptSelection()) setFollowing(true);
  }
  function holdReading() { setFollowing(false); }
  function choose(row: TranscriptSegment) { s.select(row.english, row.id); holdReading(); }
  function returnToLatest() {
    window.getSelection()?.removeAllRanges();
    setFollowing(true);
    scrollToLatest();
  }
  async function copy() { try { await navigator.clipboard.writeText(s.answer); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { setCopied(false); } }
  function submitManual() { if (!manualText.trim()) return; s.addManual(manualText.trim()); setManualText(''); setManual(false); }
  async function ask() { setTab('answer'); await s.ask(); }
  async function chooseTabAudio() {
    if (busy || s.ended) return;
    const gen = ++sourceGeneration.current;
    setChoosingSource(true); setSourceError('');
    const paused = s.pause();
    try {
      // The native picker must open in this click, before awaiting the previous input's drain.
      const input = await requestTabAudio();
      if (gen !== sourceGeneration.current) { input.close(); return; }
      pendingCapture.current = input;
      await paused;
      if (gen !== sourceGeneration.current) return;
      s.resume(input); pendingCapture.current = null;
    } catch (e) {
      pendingCapture.current?.close(); pendingCapture.current = null;
      if (gen === sourceGeneration.current) setSourceError(e instanceof Error ? e.message : '無法分享會議音訊，請重新選擇分頁。');
    } finally {
      await paused;
      if (gen === sourceGeneration.current) setChoosingSource(false);
    }
  }
  return <div className="workspace-page">
    <header className="workspace-heading"><div><div className="eyebrow">A LITTLE CLARITY. A BETTER CONVERSATION.</div><h1>跟上對話，想好再回答<span className="cyan">。</span></h1><div className="session-meta"><span className={`status-badge ${s.isDemo ? 'demo' : ''}`}><span className={`status-dot ${s.speechState === 'listening' && !busy && !s.isDemo ? 'pulse' : ''}`}/>{status}</span><span>English <span className="muted">→</span> 繁體中文</span><span className="meta-divider"/><span>{s.sessionSettings?.translationMode === 'local' ? '本機翻譯' : s.sessionSettings?.translationMode === 'cloud' ? '雲端翻譯 · 計費' : '英文字幕'}</span>{!s.isDemo && <span>{tabAudio ? '會議分頁音訊' : '麥克風'}</span>}</div></div><button className="button secondary settings-button" disabled={busy} onClick={onSettings}><Settings2 size={17}/>本次設定</button></header>
    {tabAudio && !s.ended && <div className="notice tab-source-controls"><span>Chrome 分頁 → 選取 Google Meet → 勾選「分享分頁音訊」→ 分享。<br/>{s.finishing ? '已停止接收新音訊，正在處理暫存音訊與尾句。' : s.bufferMs > 0 ? `暫存音訊約 ${Math.ceil(s.bufferMs / 1000)} 秒；${s.speechState === 'reconnecting' ? '連線恢復後繼續處理。' : '正在依序辨識。'}` : '重新選擇分頁會保留逐字稿與本次用量。'}</span><button className="button secondary" disabled={busy} onClick={() => { void chooseTabAudio(); }}>重新選擇分頁</button></div>}
    {sourceError && <div className="notice error" role="alert">{sourceError}</div>}
    {s.error && <div className="notice error" role="alert">{s.error}<button className="text-button" onClick={() => setManual(true)}>貼上英文 <ArrowLeft size={16}/></button></div>}
    {s.notice && <div className={`notice ${s.isDemo ? 'demo-notice' : ''}`} role="status">{s.isDemo && <Sparkles size={17}/>}<span>{s.notice}</span></div>}
    {spend >= budget * .8 && <div className="notice warning" role="status">{spend >= budget ? '已達預算，新的付費請求已暫停。' : '即將達到預算，請留意用量。'} 本機字幕與翻譯不受影響。</div>}
    <div className="mobile-tabs" role="group" aria-label="工作區顯示"><button aria-pressed={tab === 'transcript'} className={tab === 'transcript' ? 'active' : ''} onClick={() => setTab('transcript')}>即時逐字稿</button><button aria-pressed={tab === 'answer'} className={tab === 'answer' ? 'active' : ''} onClick={() => setTab('answer')}>回答助手 {s.selected && <span className="tab-dot"/>}</button></div>
    <div className="workspace-grid">
      <section className={`panel transcript-panel ${tab !== 'transcript' ? 'mobile-hidden' : ''}`} aria-labelledby="transcript-heading">
        <div className="panel-heading"><div><h2 id="transcript-heading">即時逐字稿</h2><p>反白文字，或選取整段取得回答建議。</p></div><button className="button compact" onClick={() => setManual(!manual)} aria-expanded={manual}><FileText size={15}/>貼上英文</button></div>
        {manual && <div className="manual-input"><label htmlFor="manual-text">貼上要翻譯的英文</label><textarea id="manual-text" autoFocus maxLength={1600} rows={3} value={manualText} placeholder="輸入面試問題，沒有麥克風也能使用。" onChange={e => setManualText(e.target.value)}/><div><small>{manualText.length} / 1,600</small><span className="manual-actions"><button className="button compact" onClick={() => setManual(false)}>收起</button><button className="button compact primary" disabled={!manualText.trim()} onClick={submitManual}><Send size={14}/>加入字幕</button></span></div></div>}
        <div ref={scroll} id="transcript-captions" role="log" aria-label="英中逐字稿" aria-live={follow ? 'polite' : 'off'} aria-relevant="additions text" className="transcript-scroll" onPointerUp={readSelection} onKeyUp={readSelection} onScroll={onTranscriptScroll} tabIndex={0}>
          <div ref={content} className="transcript-content">
          {!s.segments.length && !s.interim && <div className="empty-transcript"><div className="listening-orb"><Mic size={29}/><span/><span/></div><h3>{s.speechState === 'listening' ? '正在聽，請自然說話。' : '從一句英文開始。'}</h3><p>對話會出現在這裡。<br/>你也可以貼上英文，先試一個問題。</p><button className="button secondary" onClick={() => setManual(true)}><FileText size={16}/>貼上英文問題</button></div>}
          {s.segments.map(row => <article className={`transcript-row ${s.selectedId === row.id ? 'selected' : ''}`} key={row.id} data-segment-id={row.id}><div className="transcript-time"><span className="caption-timestamp">{formatTime(row.time)} · </span>{s.selectedId === row.id ? '已選取' : s.isDemo ? '示範內容' : row.recognitionState ? '辨識未確認' : '已完成'}{s.selectedId === row.id && row.recognitionState && ' · 辨識未確認'}</div><p className="english" lang="en">{row.english}</p>{row.chinese && <p className="chinese" lang="zh-Hant">{row.chinese}</p>}{row.translationState === 'pending' && <p className="translation-progress"><LoaderCircle size={13} className="spin"/>翻譯中…</p>}{row.translationState === 'error' && <div className="row-error"><span>{row.error}</span><button className="text-button" disabled={s.ended} onClick={() => s.retryTranslation(row)}><RotateCcw size={13}/>重試</button></div>}<button className={`button compact ${s.selectedId === row.id ? 'ai-button' : 'select-button'}`} onClick={() => choose(row)}>{s.selectedId === row.id ? <Check size={14}/> : null}{s.selectedId === row.id ? '已選取此段' : '選取整段'}</button></article>)}
          {s.interim && <article className="transcript-row interim" key="interim" aria-live="off"><div className="transcript-time"><span className="caption-timestamp">{formatTime(s.elapsed)} · </span>辨識中</div><p className="english" lang="en">{s.interim}<span className="caret"/></p><p className="field-hint">辨識中，完成後加入逐字稿。</p></article>}
        </div></div><div className="transcript-footer"><span className="transcript-follow-status"><Check size={15}/>{follow ? '自動跟隨最新字幕' : '閱讀中，畫面保持原位'}</span><button className="text-button" onClick={returnToLatest}>回到最新 <ArrowDown size={14}/></button></div>
      </section>
      <section className={`panel answer-panel ${tab !== 'answer' ? 'mobile-hidden' : ''}`} aria-labelledby="answer-heading"><div className="panel-heading"><div><h2 id="answer-heading"><Sparkles size={21} className="violet-text"/>回答助手</h2><p>{s.sessionSettings?.provider === 'gemini' ? 'Gemini' : 'OpenAI'} · 依你選取的內容產生</p></div><span className="label-pill">{s.isDemo ? '示範' : '按需生成'}</span></div>
        <div className="answer-scroll">
          {!s.selected && !s.answer && <div className="empty-answer"><div className="selection-illustration"><span/><span/><span/><Sparkles size={23}/></div><h3>把問題圈起來，<br/>讓思路清楚起來。</h3><p>在逐字稿中反白文字，或按「選取整段」。<br/>按下產生後，才會使用 AI。</p></div>}
          {s.selected && <div className="selected-question"><div className="label-row"><span>已選取的內容</span><span>{s.selected.length} / 1,000 字元</span></div><p>{s.selected}</p><div className="answer-actions"><button className="button ai-button" disabled={s.answerBusy} onClick={ask}>{s.answerBusy ? <LoaderCircle size={17} className="spin"/> : <Sparkles size={17}/>} {s.answerBusy ? '正在整理回答…' : s.isDemo ? '產生回答 · 示範' : '產生回答'}</button>{s.answerBusy && <button className="button compact" onClick={s.cancelAnswer}><X size={15}/>取消</button>}</div></div>}
          {s.answerError && <div className="answer-error" role="alert">{s.answerError}</div>}
          {s.answerBusy && <div className="answer-loading" role="status"><div/><div/><div/><p>整理英文建議與中文思路…</p></div>}
          {s.answer && <div className="answer-result"><div className="answer-result-heading"><span className="violet-text">回答建議</span><span>請依真實經驗調整</span></div>{s.answerQuestion !== s.selected && <p className="prior-question">此回答針對：{s.answerQuestion}</p>}<div className="answer-text">{s.answer}</div><div className="answer-tools"><button className="button secondary" onClick={copy}>{copied ? <Check size={16}/> : <Copy size={16}/>} {copied ? '已複製' : '複製回答'}</button><button className="button secondary" disabled={s.answerBusy || !s.selected} onClick={() => s.ask('star')}><Sparkles size={15}/>STAR 架構</button></div></div>}
        </div><div className="answer-footer"><span className="status-dot"/>只在你提出請求時產生 AI 回答</div>
      </section>
    </div>
    {s.selected && tab === 'transcript' && <button className="mobile-answer-cta button ai-button" onClick={() => setTab('answer')}><Sparkles size={17}/>已選取內容 · 前往回答助手 <ArrowRightIcon/></button>}
    <footer className="session-controls"><div className="session-clock"><span className="status-dot"/><strong>{formatTime(s.elapsed)}</strong><span>{s.isDemo ? '示範' : s.ended ? '已結束' : '本次訪談'}</span></div><div className="session-usage"><span>本次預估費用</span><strong>{formatMoney(spend)}</strong><div className="budget-track" role="meter" aria-label="預算使用比例" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(spend / budget * 100))}><i style={{ width: `${Math.min(100, spend / budget * 100)}%` }}/></div></div><div className="token-details"><span>輸入 {s.usage.inputTokens.toLocaleString()} / 輸出 {s.usage.outputTokens.toLocaleString()} tokens</span><span>預算 {formatMoney(budget)}{s.usage.unconfirmed > 0 ? ` · ${s.usage.unconfirmed} 筆待確認用量` : s.usage.reserved > 0 ? ' · 含進行中預留費用' : ' · 依 API usage 估算'}</span></div><details className="mobile-usage-details"><summary>用量</summary><div className="usage-popover"><p>本次時間 {formatTime(s.elapsed)} · 預估費用 {formatMoney(spend)}</p><p>輸入 {s.usage.inputTokens.toLocaleString()} / 輸出 {s.usage.outputTokens.toLocaleString()} tokens</p><p>預算 {formatMoney(budget)}{s.usage.unconfirmed > 0 ? ` · ${s.usage.unconfirmed} 筆待確認用量` : s.usage.reserved > 0 ? ' · 含進行中預留費用' : ' · 依 API usage 估算'}</p></div></details><div className="session-buttons"><button className="button secondary export-button" aria-label="匯出完整逐字稿" disabled={!s.segments.length} onClick={() => exportTranscript(s.segments, s.answer, s.isDemo)}><Download size={16}/><span>匯出</span></button>{!s.ended && !s.isDemo && <button className="button secondary" disabled={busy} onClick={() => { if (s.speechState === 'paused' || s.speechState === 'error') { if (tabAudio) void chooseTabAudio(); else s.resume(); } else void s.pause(); }}>{s.speechState === 'paused' || s.speechState === 'error' ? <Play size={16}/> : <Pause size={16}/>} {s.speechState === 'paused' || s.speechState === 'error' ? '繼續' : '暫停'}</button>}<button className={`button ${s.ended ? 'secondary' : 'end-button'}`} disabled={busy} onClick={() => { if (s.ended) onSettings(); else void s.stop(); }}>{s.ended ? <Settings2 size={16}/> : <Square size={13} fill="currentColor"/>}{s.ended ? '新訪談設定' : '結束訪談'}</button></div></footer>
  </div>;
}
function ArrowRightIcon() { return <span aria-hidden="true">→</span>; }
