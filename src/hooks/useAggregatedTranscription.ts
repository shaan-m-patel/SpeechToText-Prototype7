import { useCallback, useEffect, useRef } from 'react';
import { isAbortError } from '../services/groqRetry';
import { SingleFlightGate } from './singleFlight';

/**
 * Submits the accumulated recording as one request at a time.
 * Stop and unmount cancel the current request and do not leave a pending resubmit.
 */
export function useAggregatedTranscription(options: {
  processAudio: (blob: Blob) => Promise<void>;
  cancel: () => void;
  label: string;
}) {
  const gateRef = useRef(new SingleFlightGate());
  const chunksRef = useRef<Blob[]>([]);
  const processRef = useRef(options.processAudio);
  const cancelRef = useRef(options.cancel);
  processRef.current = options.processAudio;
  cancelRef.current = options.cancel;
  const label = options.label;

  const run = useCallback(async () => {
    const token = gateRef.current.requestRun();
    if (token === null) return;

    const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
    if (blob.size === 0) {
      if (gateRef.current.finishRun(token)) void run();
      return;
    }

    try {
      await processRef.current(blob);
    } catch (error) {
      if (!isAbortError(error)) {
        console.error(`${label} aggregated transcription failed`, error);
      }
    } finally {
      if (gateRef.current.finishRun(token)) void run();
    }
  }, [label]);

  const startSession = useCallback(() => {
    chunksRef.current = [];
    gateRef.current.beginRecording();
    cancelRef.current();
  }, []);

  const pushChunk = useCallback((data: Blob) => {
    if (!gateRef.current.isActive || data.size === 0) return;
    chunksRef.current.push(data);
    void run();
  }, [run]);

  const finishSession = useCallback(async (finalBlob: Blob | null) => {
    gateRef.current.cancelRecording();
    cancelRef.current();
    if (!finalBlob || finalBlob.size === 0) {
      chunksRef.current = [];
      return;
    }
    chunksRef.current = [finalBlob];
    await run();
  }, [run]);

  useEffect(() => {
    const gate = gateRef.current;
    return () => {
      gate.cancelRecording();
      cancelRef.current();
    };
  }, []);

  return { startSession, pushChunk, finishSession };
}
