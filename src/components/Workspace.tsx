import { ArrowDown, ArrowLeft, Check, Copy, Download, FileText, LoaderCircle, Mic, Pause, Play, RotateCcw, Send, Settings2, Sparkles, Square, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { useInterview } from '../hooks/useInterview';
import { useTranscriptSelection } from '../hooks/useTranscriptSelection';
import { exportTranscript, formatMoney, formatTime } from '../lib/session';
import type { TranscriptSegment } from '../types';

type Interview = ReturnType<typeof useInterview>;
const MOBILE_CAPTIONS_QUERY = '(max-width: 760px), (max-width: 950px) and (max-height: 500px)';
type CaptionSnapshot = { row: TranscriptSegment | undefined; interim: string; elapsed: number };
export function Workspace({ session: s, onSettings }: { session: Interview; onSettings: () => void }) {
  const [manual, setManual] = useState(false), [manualText, setManualText] = useState('');
  const [tab, setTab] = useState<'transcript' | 'answer'>('transcript');
  const [follow, setFollow] = useState(true), [copied, setCopied] = useState(false);
  const [mobile, setMobile] = useState(() => window.matchMedia(MOBILE_CAPTIONS_QUERY).matches);
  const [showHistory, setShowHistory] = useState(false);
  const [heldCaption, setHeldCaption] = useState<CaptionSnapshot | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const latestRow = s.segments.at(-1);
  const latestMode = mobile && !showHistory;
  const currentCaption = heldCaption ?? { row: s.interim ? undefined : latestRow, interim: s.interim, elapsed: s.elapsed };
  // Pin the caption's identity and English, while allowing its translation to finish or retry.
  const heldRowUpdate = heldCaption?.row && s.segments.find(row => row.id === heldCaption.row?.id);
  const currentRow = currentCaption.row && heldRowUpdate ? { ...heldRowUpdate, english: currentCaption.row.english } : currentCaption.row;
  const visibleRows = latestMode ? currentRow ? [currentRow] : [] : s.segments;
  const visibleInterim = latestMode ? currentCaption.interim : s.interim;
  const readSelection = useTranscriptSelection(scroll, { onSelect: text => s.select(text), onSelectionStart: holdReading });
  const status = s.isDemo ? '示範模式' : ({ idle: '尚未開始', requesting: '等待麥克風權限', listening: '聆聽中', reconnecting: '正在重新連線', paused: '已暫停', stopped: '已結束', error: '需要處理' }[s.speechState]);
  const spend = s.usage.spent + s.usage.reserved, budget = s.sessionSettings?.budgetUsd || .5;
  useEffect(() => {
    const media = window.matchMedia(MOBILE_CAPTIONS_QUERY);
    const update = () => setMobile(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => { if (follow && !window.getSelection()?.toString()) scrollToLatest(); }, [s.segments, s.interim, follow, latestMode]);
  function scrollToLatest() {
    const element = scroll.current;
    element?.scrollTo({ top: latestMode ? 0 : element.scrollHeight, behavior: latestMode || window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }
  function holdReading() {
    if (!s.hasSession || (!currentCaption.row && !currentCaption.interim.trim())) return;
    setFollow(false);
    // Keep the same row and text nodes mounted while native selection handles move.
    if (latestMode) setHeldCaption(previous => previous ?? currentCaption);
  }
  function choose(row: TranscriptSegment) {
    s.select(row.english, row.id); setFollow(false);
    if (mobile) setHeldCaption({ row, interim: '', elapsed: row.time });
  }
  function returnToLatest() {
    setHeldCaption(null); setShowHistory(false); setFollow(true);
    window.getSelection()?.removeAllRanges();
    scrollToLatest();
  }
  function toggleHistory() {
    setShowHistory(previous => !previous); setFollow(false);
  }
  async function copy() { try { await navigator.clipboard.writeText(s.answer); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { setCopied(false); } }
  function submitManual() { if (!manualText.trim()) return; s.addManual(manualText.trim()); setManualText(''); setManual(false); }
  async function ask() { setTab('answer'); await s.ask(); }
  return <div className="workspace-page">
    <header className="workspace-heading"><div><div className="eyebrow">A LITTLE CLARITY. A BETTER CONVERSATION.</div><h1>跟上對話，想好再回答<span className="cyan">。</span></h1><div className="session-meta"><span className={`status-badge ${s.isDemo ? 'demo' : ''}`}><span className={`status-dot ${s.speechState === 'listening' && !s.isDemo ? 'pulse' : ''}`}/>{status}</span><span>English <span className="muted">→</span> 繁體中文</span><span className="meta-divider"/><span>{s.sessionSettings?.translationMode === 'local' ? '本機翻譯' : s.sessionSettings?.translationMode === 'cloud' ? '雲端翻譯 · 計費' : '英文字幕'}</span></div></div><button className="button secondary settings-button" onClick={onSettings}><Settings2 size={17}/>本次設定</button></header>
    {s.error && <div className="notice error" role="alert">{s.error}<button className="text-button" onClick={() => setManual(true)}>貼上英文 <ArrowLeft size={16}/></button></div>}
    {s.notice && <div className={`notice ${s.isDemo ? 'demo-notice' : ''}`} role="status">{s.isDemo && <Sparkles size={17}/>}<span>{s.notice}</span></div>}
    {spend >= budget * .8 && <div className="notice warning" role="status">{spend >= budget ? '已達預算，新的付費請求已暫停。' : '即將達到預算，請留意用量。'} 本機字幕與翻譯不受影響。</div>}
    <div className="mobile-tabs" role="group" aria-label="工作區顯示"><button aria-pressed={tab === 'transcript'} className={tab === 'transcript' ? 'active' : ''} onClick={() => setTab('transcript')}>即時逐字稿</button><button aria-pressed={tab === 'answer'} className={tab === 'answer' ? 'active' : ''} onClick={() => setTab('answer')}>回答助手 {s.selected && <span className="tab-dot"/>}</button></div>
    <div className="workspace-grid">
      <section className={`panel transcript-panel ${latestMode ? 'latest-caption' : ''} ${tab !== 'transcript' ? 'mobile-hidden' : ''}`} aria-labelledby="transcript-heading">
        <div className="panel-heading"><div><h2 id="transcript-heading">即時逐字稿</h2><p>反白文字，或選取整段取得回答建議。</p></div><button className="button compact" onClick={() => setManual(!manual)} aria-expanded={manual}><FileText size={15}/>貼上英文</button></div>
        {manual && <div className="manual-input"><label htmlFor="manual-text">貼上要翻譯的英文</label><textarea id="manual-text" autoFocus maxLength={1600} rows={3} value={manualText} placeholder="輸入面試問題，沒有麥克風也能使用。" onChange={e => setManualText(e.target.value)}/><div><small>{manualText.length} / 1,600</small><span className="manual-actions"><button className="button compact" onClick={() => setManual(false)}>收起</button><button className="button compact primary" disabled={!manualText.trim()} onClick={submitManual}><Send size={14}/>加入字幕</button></span></div></div>}
        <div ref={scroll} id="transcript-captions" role="log" aria-label="英中逐字稿" aria-live={follow ? 'polite' : 'off'} aria-relevant="additions text" className="transcript-scroll" onPointerUp={readSelection} onKeyUp={readSelection} onWheel={holdReading} onTouchMove={holdReading}>
          {!s.segments.length && !s.interim && <div className="empty-transcript"><div className="listening-orb"><Mic size={29}/><span/><span/></div><h3>{s.speechState === 'listening' ? '正在聽，請自然說話。' : '從一句英文開始。'}</h3><p>對話會出現在這裡。<br/>你也可以貼上英文，先試一個問題。</p><button className="button secondary" onClick={() => setManual(true)}><FileText size={16}/>貼上英文問題</button></div>}
          {visibleRows.map(row => <article className={`transcript-row ${s.selectedId === row.id ? 'selected' : ''}`} key={row.id} data-segment-id={row.id}><div className="transcript-time"><span className="caption-timestamp">{formatTime(row.time)} · </span>{latestMode && heldCaption ? '閱讀中 · 已固定' : s.selectedId === row.id ? '已選取' : s.isDemo ? '示範內容' : latestMode ? '最新一句' : '已完成'}</div><p className="english">{row.english}</p>{row.chinese && <p className="chinese">{row.chinese}</p>}{row.translationState === 'pending' && <p className="translation-progress"><LoaderCircle size={13} className="spin"/>翻譯中…</p>}{row.translationState === 'error' && <div className="row-error"><span>{row.error}</span><button className="text-button" disabled={s.ended} onClick={() => s.retryTranslation(row)}><RotateCcw size={13}/>重試</button></div>}<button className={`button compact ${s.selectedId === row.id ? 'ai-button' : 'select-button'}`} onClick={() => choose(row)}>{s.selectedId === row.id ? <Check size={14}/> : null}{s.selectedId === row.id ? '已選取此段' : '選取整段'}</button></article>)}
          {visibleInterim && <article className="transcript-row interim" key="interim" aria-live="off"><div className="transcript-time"><span className="caption-timestamp">{formatTime(latestMode ? currentCaption.elapsed : s.elapsed)} · </span>{latestMode && heldCaption ? '閱讀中 · 已固定' : '辨識中'}</div><p className="english">{visibleInterim}<span className="caret"/></p><p className="field-hint">{latestMode && heldCaption ? '按「回到最新」繼續跟隨字幕。' : '等待句子完成後翻譯…'}</p></article>}
        </div><div className="transcript-footer"><span className="transcript-follow-status"><Check size={15}/>{follow ? '自動跟隨最新字幕' : '閱讀中，畫面保持原位'}</span>{mobile && <button className="text-button history-toggle" aria-expanded={showHistory} aria-controls="transcript-captions" onClick={toggleHistory}>{showHistory ? '收起歷史字幕' : `查看歷史字幕 (${s.segments.length})`}</button>}<button className="text-button" onClick={returnToLatest}>回到最新 <ArrowDown size={14}/></button></div>
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
    <footer className="session-controls"><div className="session-clock"><span className="status-dot"/><strong>{formatTime(s.elapsed)}</strong><span>{s.isDemo ? '示範' : s.ended ? '已結束' : '本次訪談'}</span></div><div className="session-usage"><span>本次預估費用</span><strong>{formatMoney(spend)}</strong><div className="budget-track" role="meter" aria-label="預算使用比例" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(spend / budget * 100))}><i style={{ width: `${Math.min(100, spend / budget * 100)}%` }}/></div></div><div className="token-details"><span>輸入 {s.usage.inputTokens.toLocaleString()} / 輸出 {s.usage.outputTokens.toLocaleString()} tokens</span><span>預算 {formatMoney(budget)}{s.usage.unconfirmed > 0 ? ` · ${s.usage.unconfirmed} 筆待確認用量` : s.usage.reserved > 0 ? ' · 含進行中預留費用' : ' · 依 API usage 估算'}</span></div><details className="mobile-usage-details"><summary>用量</summary><div className="usage-popover"><p>本次時間 {formatTime(s.elapsed)} · 預估費用 {formatMoney(spend)}</p><p>輸入 {s.usage.inputTokens.toLocaleString()} / 輸出 {s.usage.outputTokens.toLocaleString()} tokens</p><p>預算 {formatMoney(budget)}{s.usage.unconfirmed > 0 ? ` · ${s.usage.unconfirmed} 筆待確認用量` : s.usage.reserved > 0 ? ' · 含進行中預留費用' : ' · 依 API usage 估算'}</p></div></details><div className="session-buttons"><button className="button secondary export-button" aria-label="匯出完整逐字稿" disabled={!s.segments.length} onClick={() => exportTranscript(s.segments, s.answer, s.isDemo)}><Download size={16}/><span>匯出</span></button>{!s.ended && !s.isDemo && <button className="button secondary" onClick={s.speechState === 'paused' || s.speechState === 'error' ? s.resume : s.pause}>{s.speechState === 'paused' || s.speechState === 'error' ? <Play size={16}/> : <Pause size={16}/>} {s.speechState === 'paused' || s.speechState === 'error' ? '繼續' : '暫停'}</button>}<button className={`button ${s.ended ? 'secondary' : 'end-button'}`} onClick={s.ended ? onSettings : s.stop}>{s.ended ? <Settings2 size={16}/> : <Square size={13} fill="currentColor"/>}{s.ended ? '新訪談設定' : '結束訪談'}</button></div></footer>
  </div>;
}
function ArrowRightIcon() { return <span aria-hidden="true">→</span>; }
