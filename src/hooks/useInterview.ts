import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnswerStyle, Settings, SpeechState, TranscriptSegment } from '../types';
import { SpeechController } from '../lib/speech';
import { createLocalTranslator } from '../lib/translator';
import { BudgetLedger } from '../lib/budget';
import { generateAnswer, translateCloud } from '../lib/ai';
import { DEMO_ANSWER, DEMO_SEGMENTS } from '../lib/session';

type LocalTranslator = Awaited<ReturnType<typeof createLocalTranslator>>;

function connectionError(settings: Settings): string | undefined {
  if (settings.connectionMode === 'personal') {
    if (!settings.apiKey.trim() || settings.apiKey.length > 1024) return '請到「本次設定」輸入有效的個人 API 金鑰，即可使用目前逐字稿產生回答。';
  } else {
    if (!settings.sessionToken.trim() || settings.sessionToken.length > 2048) return '請到「本次設定」重新連線私人代理，即可繼續使用目前逐字稿。';
    try {
      const url = new URL(settings.gatewayUrl.trim());
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
    } catch { return '私人代理網址必須是有效的 HTTPS 網址。'; }
  }
}

function splitTranscript(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > 1500) {
    let end = 1500;
    for (let index = end; index > 0; index--) {
      if (/\s/.test(remaining[index])) { end = index; break; }
    }
    // A single unusually long word must be split, without cutting a surrogate pair.
    const last = remaining.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function reservedInput(payload: unknown, overhead: number): number {
  return new TextEncoder().encode(JSON.stringify(payload)).length + overhead;
}

export function useInterview() {
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [interim, setInterim] = useState('');
  const [speechState, setSpeechState] = useState<SpeechState>('idle');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [isDemo, setIsDemo] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [ended, setEnded] = useState(false);
  const [selected, setSelected] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [answer, setAnswer] = useState('');
  const [answerQuestion, setAnswerQuestion] = useState('');
  const [answerBusy, setAnswerBusy] = useState(false);
  const [answerError, setAnswerError] = useState('');
  const [usage, setUsage] = useState({ spent: 0, reserved: 0, inputTokens: 0, outputTokens: 0, unconfirmed: 0 });
  const [sessionSettings, setSessionSettings] = useState<Settings | null>(null);
  const settingsRef = useRef<Settings | null>(null);
  const speech = useRef<SpeechController | null>(null);
  const local = useRef<LocalTranslator | null>(null);
  const ledger = useRef<BudgetLedger | null>(null);
  const generation = useRef(0);
  const translationEpoch = useRef(0);
  const clock = useRef<{ accumulatedMs: number; startedAt: number | null }>({ accumulatedMs: 0, startedAt: null });
  const demoRef = useRef(false);
  const endedRef = useRef(false);
  const segmentsRef = useRef<TranscriptSegment[]>([]);
  const queue = useRef(Promise.resolve());
  const pendingTranslations = useRef(new Set<string>());
  const aborters = useRef(new Map<AbortController, { ledger: BudgetLedger; requestId: string }>());
  const answerAbort = useRef<AbortController | null>(null);
  const seen = useRef(new Set<string>());
  const updateElapsed = useCallback(() => {
    const activeMs = clock.current.startedAt === null ? 0 : Math.max(0, performance.now() - clock.current.startedAt);
    const seconds = Math.floor((clock.current.accumulatedMs + activeMs) / 1000);
    setElapsed(seconds);
    return seconds;
  }, []);
  const pauseClock = useCallback(() => {
    if (clock.current.startedAt !== null) {
      clock.current.accumulatedMs += Math.max(0, performance.now() - clock.current.startedAt);
      clock.current.startedAt = null;
    }
    updateElapsed();
  }, [updateElapsed]);
  const updateUsage = useCallback(() => { if (ledger.current) setUsage({ ...ledger.current.snapshot }); }, []);
  const updateConnection = useCallback((credentials: Pick<Settings, 'apiKey' | 'sessionToken' | 'accessCode'>): void => {
    if (!settingsRef.current) return;
    const updated = {
      ...settingsRef.current,
      apiKey: credentials.apiKey,
      sessionToken: credentials.sessionToken,
      accessCode: credentials.accessCode,
    };
    settingsRef.current = updated;
    setSessionSettings(updated);
    setAnswerError('');
  }, []);
  const cancelRequest = useCallback((controller: AbortController) => {
    const request = aborters.current.get(controller);
    // Cancellation cannot prove that a submitted request was free. Keep its reservation.
    request?.ledger.settle(request.requestId);
    controller.abort();
    aborters.current.delete(controller);
  }, []);
  const cancelRequests = useCallback(() => {
    for (const controller of aborters.current.keys()) cancelRequest(controller);
  }, [cancelRequest]);
  useEffect(() => { segmentsRef.current = segments; }, [segments]);
  const clockRunning = hasSession && !ended && speechState !== 'paused';
  useEffect(() => {
    if (!clockRunning) return;
    // The interval refreshes the display; monotonic time, not callback count, measures duration.
    const timer = window.setInterval(updateElapsed, 1000);
    return () => clearInterval(timer);
  }, [clockRunning, updateElapsed]);
  useEffect(() => () => { generation.current++; translationEpoch.current++; speech.current?.stop(); cancelRequests(); }, [cancelRequests]);

  const translate = useCallback((id: string, text: string, gen: number) => {
    if (demoRef.current || endedRef.current || gen !== generation.current) return;
    const epoch = translationEpoch.current;
    const pending = pendingTranslations.current;
    if (pending.has(id)) return;
    pending.add(id);
    const current = () => gen === generation.current && epoch === translationEpoch.current && !endedRef.current && !demoRef.current;
    setSegments(rows => rows.map(row => row.id === id ? { ...row, translationState: 'pending', error: undefined } : row));
    queue.current = queue.current.then(async () => {
      if (!current()) return;
      const settings = settingsRef.current!;
      const activeLedger = ledger.current!;
      const requestId = crypto.randomUUID();
      const controller = new AbortController();
      let reserved = false;
      try {
        if (!text.trim() || text.length > 1600) throw new Error('翻譯內容必須介於 1 到 1600 字元。英文內容已保留。');
        let result: string;
        if (settings.translationMode === 'local') {
          if (!local.current) throw new Error('本機翻譯尚未準備好。回首頁準備後，可開始新訪談；目前仍保留英文。');
          result = await local.current.translate(text);
        } else if (settings.translationMode === 'cloud') {
          const authError = connectionError(settings);
          if (authError) throw new Error(authError);
          reserved = activeLedger.reserve(requestId, { inputTokens: reservedInput({ text }, 1000), outputTokens: 500 });
          if (!reserved) throw new Error('剩餘預算不足，已暫停付費翻譯；英文字幕會繼續。');
          aborters.current.set(controller, { ledger: activeLedger, requestId }); updateUsage();
          const response = await translateCloud(settings, text, controller.signal);
          activeLedger.settle(requestId, response.usage); result = response.text;
        } else return;
        if (current() && !controller.signal.aborted) setSegments(rows => rows.map(s => s.id === id ? { ...s, chinese: result, translationState: 'done', error: undefined } : s));
      } catch (e) {
        if (reserved) activeLedger.settle(requestId);
        if (current()) setSegments(rows => rows.map(s => s.id === id ? { ...s, translationState: 'error', error: e instanceof Error ? e.message : '翻譯暫時無法使用' } : s));
      } finally { aborters.current.delete(controller); if (gen === generation.current) updateUsage(); }
    }).catch(() => { /* Each row owns its error; keep the queue usable. */ }).finally(() => { pending.delete(id); });
  }, [updateUsage]);

  const addSegment = useCallback((id: string, text: string) => {
    const clean = text.trim();
    if (!clean || seen.current.has(id)) return;
    seen.current.add(id);
    const mode = demoRef.current || endedRef.current ? 'off' : settingsRef.current?.translationMode || 'off';
    const chunks = splitTranscript(clean);
    const time = updateElapsed();
    const added: TranscriptSegment[] = chunks.map((english, index) => ({
      id: chunks.length === 1 ? id : `${id}:part-${index}`, english, chinese: '', time,
      translationState: mode === 'off' ? 'off' : 'pending',
    }));
    setSegments(rows => [...rows, ...added]);
    if (mode !== 'off') for (const row of added) translate(row.id, row.english, generation.current);
  }, [translate, updateElapsed]);

  const start = useCallback((settings: Settings, demo: boolean, translator: LocalTranslator | null) => {
    const nextLedger = new BudgetLedger(settings.budgetUsd, settings.provider);
    generation.current++; translationEpoch.current++; speech.current?.stop(); speech.current = null; cancelRequests();
    answerAbort.current = null; queue.current = Promise.resolve(); seen.current = new Set(); pendingTranslations.current = new Set();
    settingsRef.current = { ...settings }; setSessionSettings({ ...settings }); local.current = translator;
    ledger.current = nextLedger; updateUsage();
    clock.current = { accumulatedMs: 0, startedAt: demo ? null : performance.now() };
    setElapsed(0); setInterim(''); setError(''); setNotice('');
    setSelected(''); setSelectedId(''); setAnswer(''); setAnswerQuestion(''); setAnswerError(''); setAnswerBusy(false);
    setHasSession(true); setEnded(false); endedRef.current = false; demoRef.current = demo; setIsDemo(demo);
    if (demo) {
      segmentsRef.current = DEMO_SEGMENTS.map((s, i) => ({ ...s, id: `demo-${i}`, time: i * 12, translationState: 'done' }));
      setSegments(segmentsRef.current);
      setSpeechState('paused'); setSelected(DEMO_SEGMENTS[1].english); setSelectedId('demo-1');
      setNotice('這是示範內容，沒有啟用麥克風，也不會呼叫付費 API。'); return;
    }
    if (settings.translationMode === 'off') {
      setNotice('中文未啟用，本次只顯示英文字幕。請在新訪談前準備好本機翻譯，或設定 API 金鑰／代理並手動選擇付費雲端翻譯。');
    } else if (settings.translationMode === 'local' && !translator) {
      setNotice('中文翻譯目前無法使用：本機翻譯尚未就緒或此裝置不支援。請準備好本機翻譯，或設定 API 金鑰／代理並手動選擇付費雲端翻譯後，開始新訪談。');
    }
    segmentsRef.current = []; setSegments([]);
    if (!SpeechController.isSupported()) { setSpeechState('error'); setError('此瀏覽器不支援語音辨識。請改用桌面 Chrome，或按「貼上英文」繼續。'); return; }
    const gen = generation.current;
    speech.current = new SpeechController({
      onInterim: t => { if (gen === generation.current && !endedRef.current) setInterim(t); },
      onFinal: (id, text) => { if (gen === generation.current && !endedRef.current) addSegment(id, text); },
      onState: s => { if (gen === generation.current && !endedRef.current) setSpeechState(s); },
      onError: msg => { if (gen === generation.current && !endedRef.current) setError(msg); },
    });
    speech.current.start();
  }, [addSegment, cancelRequests, updateUsage]);

  function pause() { if (endedRef.current) return; pauseClock(); speech.current?.pause(); setSpeechState('paused'); setInterim(''); }
  function resume() {
    if (endedRef.current) return;
    setError('');
    if (demoRef.current) { setSpeechState('paused'); return; }
    if (clock.current.startedAt === null) clock.current.startedAt = performance.now();
    speech.current?.start();
  }
  function stop() {
    pauseClock();
    endedRef.current = true; translationEpoch.current++; setEnded(true); speech.current?.stop(); setSpeechState('stopped'); setInterim('');
    cancelAnswer(); cancelRequests(); updateUsage();
    pendingTranslations.current = new Set(); queue.current = Promise.resolve();
    setSegments(rows => rows.map(row => row.translationState === 'pending' ? { ...row, translationState: 'off', error: undefined } : row));
    setNotice('訪談已結束，逐字稿仍保留在這個分頁。你可以匯出或繼續整理回答。');
  }
  function select(text: string, id = '') { setSelected(text.trim().slice(0, 1000)); setSelectedId(id); setAnswerError(''); }
  async function ask(style: AnswerStyle = settingsRef.current?.answerStyle || 'concise') {
    if (answerAbort.current || !selected.trim()) return;
    if (demoRef.current) { setAnswerQuestion(selected); setAnswer(DEMO_ANSWER); return; }
    const settings = settingsRef.current;
    if (!settings || !ledger.current) return;
    const authError = connectionError(settings);
    if (authError) { setAnswerError(authError); return; }
    if (style !== 'concise' && style !== 'star') { setAnswerError('請選擇支援的回答格式。'); return; }
    const index = segmentsRef.current.findIndex(s => s.id === selectedId);
    const contextRows = index < 0 ? [] : segmentsRef.current.slice(Math.max(0, index - 2), index);
    const request = { question: selected.trim().slice(0, 1000), context: contextRows.map(s => s.english).join('\n').slice(-1600), profile: settings.profile.slice(0, 1800), style };
    const gen = generation.current, activeLedger = ledger.current!, requestId = crypto.randomUUID();
    if (!activeLedger.reserve(requestId, { inputTokens: reservedInput(request, 2200), outputTokens: 1000 })) { setAnswerError('剩餘預算不足，已停止新的付費請求。'); return; }
    const controller = new AbortController(); answerAbort.current = controller; aborters.current.set(controller, { ledger: activeLedger, requestId });
    setAnswerBusy(true); setAnswerError(''); setAnswer(''); setAnswerQuestion(request.question); updateUsage();
    try {
      const result = await generateAnswer(settings, request, controller.signal);
      activeLedger.settle(requestId, result.usage);
      if (gen === generation.current && answerAbort.current === controller && !controller.signal.aborted) setAnswer(result.text);
    } catch (e) {
      activeLedger.settle(requestId);
      if (gen === generation.current && answerAbort.current === controller && !controller.signal.aborted) setAnswerError(e instanceof Error ? e.message : '產生回答失敗，請稍後重試。');
    } finally {
      aborters.current.delete(controller);
      if (gen === generation.current) {
        if (answerAbort.current === controller) { answerAbort.current = null; setAnswerBusy(false); }
        updateUsage();
      }
    }
  }
  function cancelAnswer() {
    const controller = answerAbort.current;
    if (!controller) return;
    cancelRequest(controller); answerAbort.current = null; setAnswerBusy(false); updateUsage();
    setAnswerError('已取消。已送出的請求可能仍計費，暫保留預估費用。');
  }
  function retryTranslation(row: TranscriptSegment) {
    if (demoRef.current || endedRef.current) return;
    const current = segmentsRef.current.find(segment => segment.id === row.id);
    if (!current || current.translationState !== 'error') return;
    translate(current.id, current.english, generation.current);
  }
  return { segments, interim, speechState, error, notice, elapsed, isDemo, hasSession, ended, selected, selectedId,
    answer, answerQuestion, answerBusy, answerError, usage, sessionSettings, start, pause, resume, stop, select, ask, cancelAnswer, updateConnection,
    addManual: (text: string) => addSegment(`manual-${crypto.randomUUID()}`, text), retryTranslation };
}
