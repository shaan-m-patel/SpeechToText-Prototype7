import { useState, useCallback, useRef, useEffect } from 'react';
import { Header } from './components/Layout/Header';
import { PrototypeLayout } from './components/Layout/PrototypeLayout';
import { AudioControls } from './components/AudioCapture/AudioControls';
import { RecordingStatus } from './components/AudioCapture/RecordingStatus';
import { TranscriptDisplay } from './components/Transcript/TranscriptDisplay';
import { ChatThread } from './components/Transcript/ChatThread';
import { useAudioCapture } from './hooks/useAudioCapture';
import { useDisplayAudioCapture } from './hooks/useDisplayAudioCapture';
import { useTranscription } from './hooks/useTranscription';
import { useAggregatedTranscription } from './hooks/useAggregatedTranscription';

type KeySource = 'unknown' | 'server' | 'session' | 'none';

function App() {
  // Session keys live in memory only. The shared Groq key stays on the server.
  const [apiKey, setApiKey] = useState<string>('');
  const [keySource, setKeySource] = useState<KeySource>('unknown');
  const isConfigured = keySource === 'server' || keySource === 'session';
  const stopMicRef = useRef<() => Promise<void>>(async () => {});
  const stopShareRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    let cancelled = false;
    fetch('/api/stt/status')
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('status unavailable')))
      .then((data: { configured?: boolean }) => {
        if (cancelled) return;
        setKeySource(data.configured ? 'server' : 'none');
      })
      .catch(() => {
        if (!cancelled) setKeySource('none');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Mic capture
  const {
    isRecording,
    isPaused,
    audioLevel,
    totalDuration,
    error: audioError,
    initialize,
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    clearError,
  } = useAudioCapture({
    onMaxDuration: () => { void stopMicRef.current(); },
  });

  // Display/tab audio capture
  const {
    isRecording: isShareRecording,
    isPaused: isSharePaused,
    totalDuration: shareDuration,
    error: shareError,
    initialize: initializeShare,
    startRecording: startShareRecording,
    stopRecording: stopShareRecording,
    pauseRecording: pauseShareRecording,
    resumeRecording: resumeShareRecording,
  } = useDisplayAudioCapture({
    onMaxDuration: () => { void stopShareRef.current(); },
  });

  // Transcription hook (Groq STT)
  const {
    segments: micSegments,
    isProcessing: isMicProcessing,
    wordCount: micWordCount,
    averageConfidence: micAvgConf,
    processAudio: processMicAudio,
    cancel: cancelMic,
    clearTranscript: clearMicTranscript,
  } = useTranscription({
    apiKey: keySource === 'session' ? apiKey : undefined,
    language: import.meta.env.VITE_DEFAULT_LANGUAGE || 'en',
    task: 'transcribe',
    enableTimestamps: true,
    model: 'whisper-large-v3-turbo',
    timestampGranularities: ['segment', 'word'],
    sourceId: 'mic',
    appendMode: false,
  });

  const {
    segments: shareSegments,
    isProcessing: isShareProcessing,
    wordCount: shareWordCount,
    averageConfidence: shareAvgConf,
    processAudio: processShareAudio,
    cancel: cancelShare,
    clearTranscript: clearShareTranscript,
  } = useTranscription({
    apiKey: keySource === 'session' ? apiKey : undefined,
    language: import.meta.env.VITE_DEFAULT_LANGUAGE || 'en',
    task: 'transcribe',
    enableTimestamps: true,
    model: 'whisper-large-v3-turbo',
    timestampGranularities: ['segment', 'word'],
    sourceId: 'share',
    appendMode: false,
  });

  const micAggregate = useAggregatedTranscription({
    processAudio: processMicAudio,
    cancel: cancelMic,
    label: 'Mic',
  });
  const shareAggregate = useAggregatedTranscription({
    processAudio: processShareAudio,
    cancel: cancelShare,
    label: 'Share',
  });

  // Initialize audio on first use
  const handleStartRecording = useCallback(async () => {
    try {
      if (!isConfigured) {
        alert('Please enter your Groq API key first');
        return;
      }

      micAggregate.startSession();

      await initialize();
      // Start recording and stream aggregate for near real-time transcription
      await startRecording((chunk) => {
        if (chunk?.data && chunk.data.size > 0) {
          micAggregate.pushChunk(chunk.data);
        }
      });
    } catch (error) {
      console.error('Failed to start recording:', error);
    }
  }, [initialize, startRecording, isConfigured, micAggregate]);

  const handleStopRecording = useCallback(async () => {
    let finalBlob: Blob | null = null;
    try {
      finalBlob = await stopRecording();
    } catch (error) {
      console.error('Failed to stop recording:', error);
    }
    await micAggregate.finishSession(finalBlob);
  }, [stopRecording, micAggregate]);

  // Display share handlers
  const handleStartShare = useCallback(async () => {
    try {
      if (!isConfigured) { alert('Please enter your Groq API key first'); return; }
      shareAggregate.startSession();
      await initializeShare();
      await startShareRecording((chunk) => {
        if (chunk?.data && chunk.data.size > 0) {
          shareAggregate.pushChunk(chunk.data);
        }
      });
    } catch (e) {
      console.error('Failed to start share recording:', e);
    }
  }, [initializeShare, startShareRecording, isConfigured, shareAggregate]);

  const handleStopShare = useCallback(async () => {
    let finalBlob: Blob | null = null;
    try {
      finalBlob = await stopShareRecording();
    } catch (e) {
      console.error('Failed to stop share recording:', e);
    }
    await shareAggregate.finishSession(finalBlob);
  }, [stopShareRecording, shareAggregate]);

  stopMicRef.current = handleStopRecording;
  stopShareRef.current = handleStopShare;

  const handleConfigureAPI = useCallback(() => {
    const key = prompt('Enter a Groq API key for this browser session. It is kept in memory only.');
    if (key && key.trim()) {
      setApiKey(key.trim());
      setKeySource('session');
    }
  }, []);

  return (
    <PrototypeLayout>
      <Header 
        title="SpeechToText Prototype7" 
        subtitle="Using Groq Whisper (OpenAI-compatible)"
      />
      
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* API Configuration */}
        {keySource === 'none' && (
          <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium text-blue-900">API Configuration Required</h3>
                <p className="text-sm text-blue-700 mt-1">
                  Set GROQ_P7_KEY for the dev server, or enter a key for this browser session.
                </p>
                <p className="text-xs text-blue-600 mt-1">
                  Session keys stay in memory and are not written into the app bundle.
                </p>
              </div>
              <button
                onClick={handleConfigureAPI}
                className="btn-primary text-sm"
              >
                Enter API Key
              </button>
            </div>
          </div>
        )}

        {/* Status Bar */}
        <div className="mb-6 flex items-center justify-between">
          <RecordingStatus
            isRecording={isRecording}
            isPaused={isPaused}
            isProcessing={isMicProcessing || isShareProcessing}
            duration={totalDuration}
            error={audioError || undefined}
          />
          
          {isConfigured && (
            <div className="flex items-center space-x-2 text-sm text-gray-600">
              <div className="w-2 h-2 bg-green-500 rounded-full"></div>
              <span>
                {keySource === 'server' ? 'API configured on the server' : 'Session key only (not saved)'}
              </span>
            </div>
          )}
        </div>

        {/* Main Content Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Audio Controls Panel */}
          <div className="space-y-6">
            <AudioControls
              isRecording={isRecording}
              isPaused={isPaused}
              totalDuration={totalDuration}
              audioLevel={audioLevel}
              error={audioError}
              onStartRecording={handleStartRecording}
              onStopRecording={handleStopRecording}
              onPauseRecording={pauseRecording}
              onResumeRecording={resumeRecording}
              onClearError={clearError}
            />

            {/* Share Controls */}
            <div className="bg-white rounded-lg shadow-sm border p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-gray-900">Share Audio Controls</h2>
                <div className="text-sm text-gray-500">Duration: {Math.round(shareDuration)}s</div>
              </div>
              {shareError && (
                <div className="mb-3 text-sm text-red-600">{shareError}</div>
              )}
              <div className="flex items-center space-x-3">
                {!isShareRecording ? (
                  <button className="btn-primary" onClick={handleStartShare}>Start Share Audio</button>
                ) : (
                  <>
                    <button className="btn-secondary" onClick={pauseShareRecording} disabled={isSharePaused}>Pause</button>
                    <button className="btn-secondary" onClick={resumeShareRecording} disabled={!isSharePaused}>Resume</button>
                    <button className="btn-danger" onClick={handleStopShare}>Stop</button>
                  </>
                )}
              </div>
              <p className="text-xs text-gray-500 mt-2">Tip: When choosing a tab/window, enable "Share tab audio".</p>
            </div>

            {/* Instructions */}
            <div className="bg-gray-50 rounded-lg p-4">
              <h3 className="text-sm font-medium text-gray-900 mb-2">Instructions</h3>
              <ul className="text-sm text-gray-600 space-y-1">
                <li>• Configure your Groq API key first</li>
                <li>• Click "Start Recording" to begin audio capture</li>
                <li>• Live transcript updates every few seconds while recording</li>
                <li>• Click "Stop" to finalize and capture any trailing audio</li>
              </ul>
            </div>
          </div>

          {/* Chat Thread Panel */}
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900 mb-2">Chat Transcript</h2>
              <ChatThread micSegments={micSegments} shareSegments={shareSegments} />
            </div>
            <div>
              <h3 className="text-sm font-medium text-gray-700 mb-1">Debug: Mic Transcript</h3>
              <TranscriptDisplay
                segments={micSegments}
                isProcessing={isMicProcessing}
                wordCount={micWordCount}
                averageConfidence={micAvgConf}
                onClearTranscript={clearMicTranscript}
              />
            </div>
            <div>
              <h3 className="text-sm font-medium text-gray-700 mb-1">Debug: Share Transcript</h3>
              <TranscriptDisplay
                segments={shareSegments}
                isProcessing={isShareProcessing}
                wordCount={shareWordCount}
                averageConfidence={shareAvgConf}
                onClearTranscript={clearShareTranscript}
              />
            </div>
          </div>
        </div>

        {/* Debug Info (Development only) */}
        {import.meta.env.DEV && (
          <div className="mt-8 p-4 bg-gray-100 rounded-lg">
            <h3 className="text-sm font-medium text-gray-900 mb-2">Debug Info</h3>
            <div className="text-xs text-gray-600 space-y-1">
              <div>Recording: {isRecording ? 'Yes' : 'No'}</div>
              <div>Paused: {isPaused ? 'Yes' : 'No'}</div>
              <div>Mic Processing: {isMicProcessing ? 'Yes' : 'No'}</div>
              <div>Mic Segments: {micSegments.length}</div>
              <div>Share Processing: {isShareProcessing ? 'Yes' : 'No'}</div>
              <div>Share Segments: {shareSegments.length}</div>
              <div>Audio Level: {Math.round(audioLevel)}%</div>
              <div>Duration: {Math.round(totalDuration)}s</div>
              {audioError && <div className="text-red-600">Error: {audioError}</div>}
            </div>
          </div>
        )}
      </main>
    </PrototypeLayout>
  );
}

export default App;
