// Azure AI Speech: ブラウザのマイク入力を連続認識する。
// 話者分離は Teams ingestor 側で扱い、ブラウザマイクは単一入力として扱う。
import { useCallback, useEffect, useRef, useState } from 'react';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:8787';

export function useSpeech({ onUtterance }) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState('idle');
  const [lastText, setLastText] = useState('');
  const [interimText, setInterimText] = useState('');
  const [lastSentAt, setLastSentAt] = useState(null);
  const [micLevel, setMicLevel] = useState(0);
  const recognizerRef = useRef(null);
  const sdkRef = useRef(null);
  const micStreamRef = useRef(null);
  const meterFrameRef = useRef(null);
  const audioContextRef = useRef(null);

  // SDK は重いので動的 import
  async function loadSdk() {
    if (sdkRef.current) return sdkRef.current;
    sdkRef.current = await import('microsoft-cognitiveservices-speech-sdk');
    return sdkRef.current;
  }

  const start = useCallback(async () => {
    setError(null);
    setLastText('');
    setInterimText('');
    setStatus('requesting microphone');
    try {
      await startMicMeter();
      const sdk = await loadSdk();
      const r = await fetch(`${SERVER_URL}/speech/token`);
      if (!r.ok) throw new Error(`token failed: ${r.status}`);
      const { token, region } = await r.json();
      setStatus('starting speech recognizer');

      const speechConfig = sdk.SpeechConfig.fromAuthorizationToken(token, region);
      speechConfig.speechRecognitionLanguage = 'ja-JP';

      const audioConfig = sdk.AudioConfig.fromDefaultMicrophoneInput();
      const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

      recognizer.sessionStarted = () => setStatus('listening');
      recognizer.recognizing = (_s, e) => {
        if (e.result?.text) {
          setInterimText(e.result.text);
          setStatus('recognizing');
        }
      };
      recognizer.recognized = (_s, e) => {
        if (e.result.reason === sdk.ResultReason.RecognizedSpeech && e.result.text) {
          setInterimText('');
          setLastText(e.result.text);
          setLastSentAt(Date.now());
          setStatus('sent transcript');
          onUtterance({ speaker: 'BrowserMic', text: e.result.text });
        } else if (e.result.reason === sdk.ResultReason.NoMatch) {
          setStatus('no speech recognized');
        }
      };
      recognizer.canceled = (_s, e) => {
        console.warn('[speech] canceled', e.errorDetails);
        setError(e.errorDetails || 'canceled');
        setStatus('canceled');
        setListening(false);
      };
      recognizer.sessionStopped = () => {
        setStatus('stopped');
        setListening(false);
      };

      await new Promise((res, rej) =>
        recognizer.startContinuousRecognitionAsync(res, rej)
      );
      recognizerRef.current = recognizer;
      setListening(true);
    } catch (e) {
      console.error('[speech] start failed', e);
      setError(e.message || String(e));
      setStatus('failed');
      stopMicMeter();
    }
  }, [onUtterance]);

  const stop = useCallback(async () => {
    const recognizer = recognizerRef.current;
    if (recognizer) {
      await new Promise((res) => recognizer.stopContinuousRecognitionAsync(res, res));
      try { recognizer.close(); } catch {}
      recognizerRef.current = null;
    }
    stopMicMeter();
    setStatus('stopped');
    setListening(false);
  }, []);

  useEffect(() => () => { if (recognizerRef.current) stop(); }, [stop]);

  async function startMicMeter() {
    stopMicMeter();
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('microphone api unavailable');
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micStreamRef.current = stream;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const audioContext = new AudioContextClass();
    audioContextRef.current = audioContext;
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const value of data) {
        const centered = value - 128;
        sum += centered * centered;
      }
      setMicLevel(Math.min(1, Math.sqrt(sum / data.length) / 48));
      meterFrameRef.current = requestAnimationFrame(tick);
    };
    tick();
  }

  function stopMicMeter() {
    if (meterFrameRef.current) cancelAnimationFrame(meterFrameRef.current);
    meterFrameRef.current = null;
    if (audioContextRef.current) {
      try { audioContextRef.current.close(); } catch {}
      audioContextRef.current = null;
    }
    if (micStreamRef.current) {
      for (const track of micStreamRef.current.getTracks()) track.stop();
      micStreamRef.current = null;
    }
    setMicLevel(0);
  }

  return { listening, error, status, lastText, interimText, lastSentAt, micLevel, start, stop };
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
    const r = await fetch(`${SERVER_URL}/teams/transcript`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ meetingId, speakerId, text, at: Date.now() }),
    });
    if (!r.ok) console.warn('postTeamsUtterance failed status', r.status);
    return r.ok;
  } catch (e) {
    console.warn('postTeamsUtterance failed', e);
    return false;
  }
}

export async function flushTranscript() {
  try {
    await fetch(`${SERVER_URL}/transcript/flush`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
  } catch (e) {
    console.warn('flushTranscript failed', e);
  }
}
