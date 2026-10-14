import type { Settings, TranscriptSegment } from '../types';

export const DEFAULT_SETTINGS: Settings = {
  connectionMode: 'personal', provider: 'openai', apiKey: '', gatewayUrl: '', accessCode: '', sessionToken: '',
  translationMode: 'local', profile: '', budgetUsd: 0.5, expectedAnswers: 20, answerStyle: 'concise',
};
export const DEMO_SEGMENTS = [
  { english: 'What interests you most about this role?', chinese: '這個職位最吸引你的地方是什麼？' },
  { english: 'Tell me about a time you handled a tight deadline.', chinese: '請分享一次你應對緊迫期限的經驗。' },
  { english: 'How did you decide what to prioritize?', chinese: '你當時如何決定事情的優先順序？' },
];
export const DEMO_ANSWER = `英文回答\n“In a recent project, we faced [describe your real deadline]. I first clarified the most important outcome, then broke the work into smaller steps. I aligned priorities with the team and raised risks early. As a result, [add your actual outcome].”\n\n中文思路\n先說真實情境，再描述排序、溝通與風險處理，最後補上具體結果。\n\n這是示範框架，請以你的真實經驗替換方括號內容。`;
export function formatTime(seconds: number) {
  const n = Math.max(0, Math.floor(seconds));
  return [Math.floor(n / 3600), Math.floor(n / 60) % 60, n % 60].map(x => String(x).padStart(2, '0')).join(':');
}
export function formatMoney(value: number) { return `US$${value > 0 && value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`; }
export function exportTranscript(segments: TranscriptSegment[], answer: string, demo: boolean) {
  const body = [`AOA 面試筆記${demo ? '（示範內容）' : ''}`, new Date().toLocaleString('zh-TW'), '',
    ...segments.flatMap(s => [`[${formatTime(s.time)}] ${s.english}`, s.chinese || '（尚無翻譯）', '']),
    ...(answer ? ['最近一次回答建議', answer] : [])].join('\n');
  const url = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = `AOA-${new Date().toISOString().slice(0, 10)}.txt`;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
