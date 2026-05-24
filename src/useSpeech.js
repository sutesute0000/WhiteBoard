// Azure AI Speech: ブラウザの ConversationTranscriber を用いた
// 話者分離付きリアルタイム文字起こし。トークンはバックエンドから取得。
import { useCallback, useEffect, useRef, useState } from 'react';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:8787';

export function useSpeech({ onUtterance }) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState(null);
  const transcriberRef = useRef(null);
  const sdkRef = useRef(null);

  // SDK は重いので動的 import
  async function loadSdk() {
    if (sdkRef.current) return sdkRef.current;
    sdkRef.current = await import('microsoft-cognitiveservices-speech-sdk');
    return sdkRef.current;
  }

  const start = useCallback(async () => {
    setError(null);
    try {
      const sdk = await loadSdk();
      const r = await fetch(`${SERVER_URL}/speech/token`);
      if (!r.ok) throw new Error(`token failed: ${r.status}`);
      const { token, region } = await r.json();

      const speechConfig = sdk.SpeechConfig.fromAuthorizationToken(token, region);
      speechConfig.speechRecognitionLanguage = 'ja-JP';
      // 話者分離を有効化
      speechConfig.setProperty(
        sdk.PropertyId.SpeechServiceConnection_TranslationFeatures,
        'speakerIdentification'
      );

      const audioConfig = sdk.AudioConfig.fromDefaultMicrophoneInput();
      const transcriber = new sdk.ConversationTranscriber(speechConfig, audioConfig);

      transcriber.transcribed = (_s, e) => {
        if (e.result.reason === sdk.ResultReason.RecognizedSpeech && e.result.text) {
          const speakerId = e.result.speakerId || 'Speaker';
          onUtterance({ speaker: 'Speaker_' + speakerId, text: e.result.text });
        }
      };
      transcriber.canceled = (_s, e) => {
        console.warn('[speech] canceled', e.errorDetails);
        setError(e.errorDetails || 'canceled');
        setListening(false);
      };
      transcriber.sessionStopped = () => setListening(false);

      await new Promise((res, rej) =>
        transcriber.startTranscribingAsync(res, rej)
      );
      transcriberRef.current = transcriber;
      setListening(true);
    } catch (e) {
      console.error('[speech] start failed', e);
      setError(e.message || String(e));
    }
  }, [onUtterance]);

  const stop = useCallback(async () => {
    const t = transcriberRef.current;
    if (!t) return;
    await new Promise((res) => t.stopTranscribingAsync(res, res));
    try { t.close(); } catch {}
    transcriberRef.current = null;
    setListening(false);
  }, []);

  useEffect(() => () => { if (transcriberRef.current) stop(); }, [stop]);

  return { listening, error, start, stop };
}

// 取得した発言をバックエンドへ送る軽量ラッパ
export async function postUtterance(speaker, text) {
  try {
    await fetch(`${SERVER_URL}/transcript`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ speaker, text }),
    });
  } catch (e) {
    console.warn('postUtterance failed', e);
  }
}
