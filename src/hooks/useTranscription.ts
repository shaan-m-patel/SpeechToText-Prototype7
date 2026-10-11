import { useState, useCallback, useRef, useEffect } from 'react';
import { GroqSTT, GroqConfig } from '../services/groqSTT.ts';
import { isAbortError } from '../services/groqRetry';
import { TranscriptSegment, TranscriptState, WizperResponse } from '../types/transcript';
import { generateSegmentId } from '../utils/audioFormat';

export function useTranscription(config: GroqConfig & { sourceId?: 'mic' | 'share'; appendMode?: boolean }) {
  const [state, setState] = useState<TranscriptState>({
    segments: [],
    isProcessing: false,
    totalDuration: 0,
    wordCount: 0,
    averageConfidence: 0,
  });

  const groqRef = useRef<GroqSTT | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const configRef = useRef(config);
  configRef.current = config;

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Process audio blob. In appendMode, we append/update instead of replacing all segments.
  const processAudio = useCallback(async (audioBlob: Blob): Promise<void> => {
    const activeConfig = configRef.current;
    if (!groqRef.current) {
      groqRef.current = new GroqSTT(activeConfig);
    } else {
      groqRef.current.updateConfig(activeConfig);
    }

    const controller = new AbortController();
    abortRef.current = controller;

    // Set processing state; in append mode, indicate pending but don't add placeholder bubble
    setState(prev => ({ ...prev, isProcessing: true }));

    try {
      const response: WizperResponse = await groqRef.current.transcribe(audioBlob, controller.signal);
      if (controller.signal.aborted) {
        setState(prev => ({ ...prev, isProcessing: false }));
        return;
      }

      if (activeConfig.appendMode) {
        const appended = squashSegments(createSegmentsFromResponse(response, activeConfig.sourceId));
        setState(prev => {
          const next = mergeIncremental(prev.segments, appended);
          return recalcState({ ...prev, isProcessing: false, segments: next }, response.duration);
        });
      } else {
        // Replace entire list (legacy behavior)
        const newSegments = squashSegments(createSegmentsFromResponse(response, activeConfig.sourceId));
        setState(prev => {
          const totalDuration = Math.max(prev.totalDuration, response.duration || 0);
          const wordCount = calculateWordCount(newSegments);
          const averageConfidence = calculateAverageConfidence(newSegments);
          return {
            segments: newSegments,
            isProcessing: false,
            totalDuration,
            wordCount,
            averageConfidence,
          };
        });
      }

    } catch (error) {
      setState(prev => ({ ...prev, isProcessing: false }));
      if (isAbortError(error) || controller.signal.aborted) return;
      throw error;
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, []);

  // Add a manual transcript segment (for testing or manual input)
  const addSegment = useCallback((text: string, confidence: number = 1.0): void => {
    const segment: TranscriptSegment = {
      id: generateSegmentId(),
      text: text.trim(),
      timestamp: Date.now(),
      confidence,
      startTime: state.totalDuration,
      endTime: state.totalDuration + 2, // Assume 2 second duration
    };

    setState(prev => {
      const newSegments = [...prev.segments, segment].filter(s => !s.isProcessing);
      return {
        ...prev,
        segments: newSegments,
        wordCount: calculateWordCount(newSegments),
        averageConfidence: calculateAverageConfidence(newSegments),
        totalDuration: Math.max(prev.totalDuration, segment.endTime),
      };
    });
  }, [state.totalDuration]);

  // Clear all transcript segments
  const clearTranscript = useCallback((): void => {
    setState({
      segments: [],
      isProcessing: false,
      totalDuration: 0,
      wordCount: 0,
      averageConfidence: 0,
    });
  }, []);

  // Get transcript as plain text
  const getTranscriptText = useCallback((): string => {
    return state.segments
      .filter(s => !s.isProcessing)
      .sort((a, b) => a.startTime - b.startTime)
      .map(s => s.text)
      .join(' ');
  }, [state.segments]);

  // Update Groq configuration
  const updateConfig = useCallback((newConfig: Partial<GroqConfig>): void => {
    if (groqRef.current) {
      groqRef.current.updateConfig(newConfig);
    }
  }, []);

  return {
    ...state,
    processAudio,
    cancel,
    addSegment,
    clearTranscript,
    getTranscriptText,
    updateConfig,
  };
}

// Helper functions
function createSegmentsFromResponse(response: WizperResponse, sourceId?: 'mic' | 'share'): TranscriptSegment[] {
  if (response.segments && response.segments.length > 0) {
    return response.segments.map((segment, index) => ({
      id: generateSegmentId(),
      text: segment.text.trim(),
      timestamp: Date.now() + index,
      confidence: segment.confidence || 0.9,
      startTime: segment.start || 0,
      endTime: segment.end || (segment.start || 0),
      sourceId,
      isFinal: true,
    }));
  }

  // Fallback: create a single segment from the full text
  return [{
    id: generateSegmentId(),
    text: (response.text || '').trim(),
    timestamp: Date.now(),
    confidence: 0.9,
    startTime: 0,
    endTime: response.duration || 0,
    sourceId,
    isFinal: true,
  }];
}

function calculateWordCount(segments: TranscriptSegment[]): number {
  return segments
    .filter(s => !s.isProcessing)
    .reduce((count, segment) => {
      return count + segment.text.split(/\s+/).filter(word => word.length > 0).length;
    }, 0);
}

function calculateAverageConfidence(segments: TranscriptSegment[]): number {
  const validSegments = segments.filter(s => !s.isProcessing);
  if (validSegments.length === 0) return 0;
  
  const totalConfidence = validSegments.reduce((sum, segment) => sum + segment.confidence, 0);
  return totalConfidence / validSegments.length;
}

// Merge new segments into existing list, deduping identical text ranges per source by time
function mergeIncremental(existing: TranscriptSegment[], incoming: TranscriptSegment[]): TranscriptSegment[] {
  if (incoming.length === 0) return existing;

  const next = [...existing];
  for (const seg of incoming) {
    // Try to find an equivalent segment (same source, overlapping time, similar text)
    const idx = next.findIndex(s => s.sourceId === seg.sourceId && Math.abs(s.startTime - seg.startTime) < 0.2 && Math.abs(s.endTime - seg.endTime) < 0.2);
    if (idx >= 0) {
      next[idx] = { ...seg };
    } else {
      next.push(seg);
    }
  }
  // Keep stable order by time
  return next.sort((a, b) => a.startTime - b.startTime || a.timestamp - b.timestamp);
}

function recalcState(state: TranscriptState, duration?: number): TranscriptState {
  const wordCount = calculateWordCount(state.segments);
  const averageConfidence = calculateAverageConfidence(state.segments);
  const totalDuration = Math.max(state.totalDuration, duration || 0);
  return { ...state, wordCount, averageConfidence, totalDuration };
}

// Utilities to squash repeated/fragmented segments from ASR responses
function normalizeText(t: string): string {
  return t
    .toLowerCase()
    .replace(/[-–—]/g, '') // remove hyphens/dashes
    .replace(/[^a-z0-9\s]/g, '') // strip punctuation
    .replace(/\s+/g, ' ') // collapse spaces
    .trim();
}

function squashSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const seg of segments.sort((a, b) => a.startTime - b.startTime)) {
    const curNorm = normalizeText(seg.text);
    if (!curNorm) continue;

    const last = out[out.length - 1];
    if (last) {
      const lastNorm = normalizeText(last.text);
      // Drop if identical text from same source, or fragment fully contained in last
      const isIdentical = lastNorm === curNorm;
      const isContained = lastNorm.includes(curNorm) || curNorm.includes(lastNorm);
      const closeInTime = Math.abs(seg.startTime - last.endTime) < 1.0; // 1s boundary
      if (isIdentical || (isContained && closeInTime)) {
        // Extend last timing to the newer end
        last.endTime = Math.max(last.endTime, seg.endTime);
        continue;
      }
      // Collapse very short fragments that are likely artifacts
      if (curNorm.length < 6 && lastNorm.endsWith(curNorm) && closeInTime) {
        last.endTime = Math.max(last.endTime, seg.endTime);
        continue;
      }
    }
    out.push({ ...seg });
  }
  return out;
}
