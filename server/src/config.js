// Configuration
import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT || '8787', 10),

  // Azure AI Speech
  azureSpeechKey: process.env.AZURE_SPEECH_KEY || '',
  azureSpeechRegion: process.env.AZURE_SPEECH_REGION || 'japaneast',

  // Azure OpenAI
  azureOpenAIEndpoint: process.env.AZURE_OPENAI_ENDPOINT || '',
  azureOpenAIKey: process.env.AZURE_OPENAI_KEY || '',
  azureOpenAIDeployment: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-5.4',
  azureOpenAIApiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-10-21',

  // Turn buffer
  minTurnChars: parseInt(process.env.MIN_TURN_CHARS || '20', 10),
  speakerChangeGraceMs: parseInt(process.env.SPEAKER_CHANGE_GRACE_MS || '2000', 10),

  // LLM 呼び出し最小インターバル (ms) — 短時間連続呼び出しを抑止
  llmMinIntervalMs: parseInt(process.env.LLM_MIN_INTERVAL_MS || '10000', 10),
  llmFallback: process.env.LLM_FALLBACK !== 'off',

  // Section summarization
  sectionSummarizeThreshold: parseInt(process.env.SUMMARIZE_AFTER_TURNS || '8', 10),
  stableSections: ['会議の目的', '論点'], // 早期に圧縮対象

  // Persistence
  store: process.env.STORE || 'file', // file | memory | cosmos
  fileStorePath: process.env.FILE_STORE_PATH || './data/boards.json',
  cosmosEndpoint: process.env.COSMOS_ENDPOINT || '',
  cosmosKey: process.env.COSMOS_KEY || '',
  cosmosDatabase: process.env.COSMOS_DATABASE || 'whiteboard',
};
