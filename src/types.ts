export type Provider = 'openai' | 'gemini';
export type ConnectionMode = 'personal' | 'gateway';
export type TranslationMode = 'local' | 'cloud' | 'off';
export type AnswerStyle = 'concise' | 'star';
export interface Settings {
  connectionMode: ConnectionMode;
  provider: Provider;
  apiKey: string;
  gatewayUrl: string;
  accessCode: string;
  sessionToken: string;
  translationMode: TranslationMode;
  profile: string;
  budgetUsd: number;
  expectedAnswers: number;
  answerStyle: AnswerStyle;
}
export interface Usage { inputTokens: number; outputTokens: number; estimated?: boolean; }
export interface AiResult { text: string; usage?: Usage; }
export interface TranscriptSegment {
  id: string;
  english: string;
  chinese: string;
  time: number;
  translationState: 'pending' | 'done' | 'error' | 'off';
  error?: string;
}
export type SpeechState = 'idle' | 'requesting' | 'listening' | 'reconnecting' | 'paused' | 'stopped' | 'error';
