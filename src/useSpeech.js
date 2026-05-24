// Azure AI Speech: ブラウザのマイク入力を連続認識する。
// 話者分離は Teams ingestor 側で扱い、ブラウザマイクは単一入力として扱う。
import { useCallback, useEffect, useRef, useState } from 'react';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:8787';

export function useSpeech({ onUtterance }) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState(null);
  const recognizerRef = useRef(null);
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

      const audioConfig = sdk.AudioConfig.fromDefaultMicrophoneInput();
      const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

      recognizer.recognized = (_s, e) => {
        if (e.result.reason === sdk.ResultReason.RecognizedSpeech && e.result.text) {
          onUtterance({ speaker: 'BrowserMic', text: e.result.text });
        }
      };
      recognizer.canceled = (_s, e) => {
        console.warn('[speech] canceled', e.errorDetails);
        setError(e.errorDetails || 'canceled');
        setListening(false);
      };
      recognizer.sessionStopped = () => setListening(false);

      await new Promise((res, rej) =>
        recognizer.startContinuousRecognitionAsync(res, rej)
      );
      recognizerRef.current = recognizer;
      setListening(true);
    } catch (e) {
      console.error('[speech] start failed', e);
      setError(e.message || String(e));
    }
  }, [onUtterance]);

  const stop = useCallback(async () => {
    const recognizer = recognizerRef.current;
    if (!recognizer) return;
    await new Promise((res) => recognizer.stopContinuousRecognitionAsync(res, res));
    try { recognizer.close(); } catch {}
    recognizerRef.current = null;
    setListening(false);
  }, []);

  useEffect(() => () => { if (recognizerRef.current) stop(); }, [stop]);

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

export async function postTeamsUtterance(speakerId, text, meetingId = 'browser-teams-test') {
  try {
    await fetch(`${SERVER_URL}/teams/transcript`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ meetingId, speakerId, text, at: Date.now() }),
    });
  } catch (e) {
    console.warn('postTeamsUtterance failed', e);
  }
}
