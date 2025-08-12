import { useState, useCallback, useRef } from 'react';
import { GroqSTT, GroqConfig } from '../services/groqSTT.ts';
import { TranscriptSegment, TranscriptState, WizperResponse } from '../types/transcript';
import { generateSegmentId } from '../utils/audioFormat';

export function useTranscription(config: GroqConfig) {
  const [state, setState] = useState<TranscriptState>({
    segments: [],
    isProcessing: false,
    totalDuration: 0,
    wordCount: 0,
    averageConfidence: 0,
  });

  const groqRef = useRef<GroqSTT | null>(null);

  // Initialize Groq STT API
  const initializeGroq = useCallback(() => {
    if (!groqRef.current) {
      groqRef.current = new GroqSTT(config);
    }
  }, [config]);

  // Process audio blob and update transcript (replace with aggregated response)
  const processAudio = useCallback(async (audioBlob: Blob): Promise<void> => {
    initializeGroq();
    
    if (!groqRef.current) {
      throw new Error('Groq STT not initialized');
    }

    // Set processing state and add a single placeholder if none exists
    setState(prev => {
      const hasProcessing = prev.segments.some(s => s.isProcessing);
      const nextSegments = hasProcessing
        ? prev.segments
        : [
            ...prev.segments,
            {
              id: generateSegmentId(),
              text: 'Processing...',
              timestamp: Date.now(),
              confidence: 0,
              startTime: prev.totalDuration,
              endTime: prev.totalDuration,
              isProcessing: true,
            } as TranscriptSegment,
          ];
      return { ...prev, isProcessing: true, segments: nextSegments };
    });

    try {
      const response: WizperResponse = await groqRef.current.transcribe(audioBlob);

      // Build new segments from absolute timestamps (replace entire list)
      const newSegments = createSegmentsFromResponse(response);

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

    } catch (error) {
      // Remove any processing placeholders
      setState(prev => ({
        ...prev,
        segments: prev.segments.filter(s => !s.isProcessing),
        isProcessing: false,
      }));
      
      throw error;
    }
  }, [initializeGroq]);

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
    addSegment,
    clearTranscript,
    getTranscriptText,
    updateConfig,
  };
}

// Helper functions
function createSegmentsFromResponse(response: WizperResponse): TranscriptSegment[] {
  if (response.segments && response.segments.length > 0) {
    return response.segments.map((segment, index) => ({
      id: generateSegmentId(),
      text: segment.text.trim(),
      timestamp: Date.now() + index,
      confidence: segment.confidence || 0.9,
      startTime: segment.start || 0,
      endTime: segment.end || (segment.start || 0),
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
