import { useState, useEffect, useCallback, useRef } from 'react';
import { AudioCaptureService } from '../services/audioCapture';
import { AudioCaptureState, AudioChunk, AudioError } from '../types/audio';
import { AUDIO_CONFIG } from '../utils/constants';

export function useAudioCapture(options: { onMaxDuration?: () => void } = {}) {
  const [state, setState] = useState<AudioCaptureState>({
    isRecording: false,
    isPaused: false,
    audioLevel: 0,
    totalDuration: 0,
    error: null,
  });

  const captureServiceRef = useRef<AudioCaptureService | null>(null);
  const durationIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const startTimeRef = useRef<number>(0);
  const cappedRef = useRef(false);
  const onMaxDurationRef = useRef(options.onMaxDuration);
  onMaxDurationRef.current = options.onMaxDuration;

  // Initialize audio capture service
  const initialize = useCallback(async (): Promise<void> => {
    try {
      setState(prev => ({ ...prev, error: null }));
      
      if (!captureServiceRef.current) {
        captureServiceRef.current = new AudioCaptureService();
      }
      
      await captureServiceRef.current.initialize();
    } catch (error) {
      const audioError = error as AudioError;
      setState(prev => ({ 
        ...prev, 
        error: audioError.message || 'Failed to initialize audio capture',
        isRecording: false,
      }));
    }
  }, []);

  // Start recording
  const startRecording = useCallback(async (onChunk?: (chunk: AudioChunk) => void): Promise<void> => {
    if (!captureServiceRef.current) {
      await initialize();
    }

    try {
      setState(prev => ({ ...prev, error: null }));
      
      await captureServiceRef.current!.startRecording(onChunk);
      
      startTimeRef.current = Date.now();
      cappedRef.current = false;
      setState(prev => ({ 
        ...prev, 
        isRecording: true, 
        isPaused: false,
        totalDuration: 0,
      }));

      // Start duration tracking
      durationIntervalRef.current = setInterval(() => {
        const elapsedMs = Date.now() - startTimeRef.current;
        const duration = elapsedMs / 1000;
        setState(prev => ({ ...prev, totalDuration: duration }));
        if (!cappedRef.current && elapsedMs >= AUDIO_CONFIG.MAX_RECORDING_DURATION) {
          cappedRef.current = true;
          const limitMinutes = Math.round(AUDIO_CONFIG.MAX_RECORDING_DURATION / 60000);
          setState(prev => ({
            ...prev,
            error: `Recording stopped at the ${limitMinutes} minute limit.`,
          }));
          onMaxDurationRef.current?.();
        }
      }, 100);

    } catch (error) {
      const audioError = error as AudioError;
      setState(prev => ({ 
        ...prev, 
        error: audioError.message || 'Failed to start recording',
        isRecording: false,
      }));
    }
  }, [initialize]);

  // Stop recording
  const stopRecording = useCallback(async (): Promise<Blob | null> => {
    if (!captureServiceRef.current) return null;

    try {
      const audioBlob = await captureServiceRef.current.stopRecording();
      
      // Clear duration interval
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
        durationIntervalRef.current = null;
      }

      setState(prev => ({ 
        ...prev, 
        isRecording: false, 
        isPaused: false,
        audioLevel: 0,
      }));

      return audioBlob;
    } catch (error) {
      const audioError = error as AudioError;
      setState(prev => ({ 
        ...prev, 
        error: audioError.message || 'Failed to stop recording',
        isRecording: false,
      }));
      return null;
    }
  }, []);

  // Pause recording
  const pauseRecording = useCallback((): void => {
    if (!captureServiceRef.current) return;

    captureServiceRef.current.pauseRecording();
    setState(prev => ({ ...prev, isPaused: true }));

    // Pause duration tracking
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }
  }, []);

  // Resume recording
  const resumeRecording = useCallback((): void => {
    if (!captureServiceRef.current) return;

    captureServiceRef.current.resumeRecording();
    setState(prev => ({ ...prev, isPaused: false }));

    // Resume duration tracking
    const pausedDuration = state.totalDuration;
    startTimeRef.current = Date.now() - (pausedDuration * 1000);
    
    durationIntervalRef.current = setInterval(() => {
      const duration = (Date.now() - startTimeRef.current) / 1000;
      setState(prev => ({ ...prev, totalDuration: duration }));
    }, 100);
  }, [state.totalDuration]);

  // Clear error
  const clearError = useCallback((): void => {
    setState(prev => ({ ...prev, error: null }));
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
      }
      if (captureServiceRef.current) {
        captureServiceRef.current.cleanup();
      }
    };
  }, []);

  return {
    ...state,
    initialize,
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    clearError,
    isAvailable: !!captureServiceRef.current,
  };
}
