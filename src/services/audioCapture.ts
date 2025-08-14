import { AudioChunk, AudioCaptureConfig, AudioError } from '../types/audio';
import { AUDIO_CONFIG } from '../utils/constants';
import { getBestSupportedMimeType } from '../utils/audioFormat';

export class AudioCaptureService {
  private mediaRecorder: MediaRecorder | null = null;
  private audioStream: MediaStream | null = null;
  private audioChunks: Blob[] = [];
  private startTime: number = 0;
  private config: AudioCaptureConfig;

  constructor(config: Partial<AudioCaptureConfig> = {}) {
    this.config = {
      sampleRate: AUDIO_CONFIG.DEFAULT_SAMPLE_RATE,
      channelCount: AUDIO_CONFIG.DEFAULT_CHANNEL_COUNT,
      bitRate: AUDIO_CONFIG.DEFAULT_BIT_RATE,
      mimeType: getBestSupportedMimeType(),
      chunkDuration: AUDIO_CONFIG.CHUNK_DURATION,
      ...config,
    };
  }

  /**
   * Initialize audio capture by requesting microphone permission
   */
  async initialize(): Promise<void> {
    try {
      const constraints: MediaStreamConstraints = {
        audio: {
          sampleRate: this.config.sampleRate,
          channelCount: this.config.channelCount,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      };

      this.audioStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.setupMediaRecorder();
    } catch (error) {
      throw this.createAudioError('PERMISSION_DENIED', 'Microphone access denied', error as Error);
    }
  }

  /**
   * Initialize with an externally provided MediaStream (e.g., getDisplayMedia with audio)
   */
  async initializeWithStream(stream: MediaStream): Promise<void> {
    try {
      this.audioStream = stream;

      // If the display stream ends, stop recording if active
      const audioTracks = this.audioStream.getAudioTracks();
      if (!audioTracks || audioTracks.length === 0) {
        throw this.createAudioError(
          'DEVICE_NOT_FOUND',
          'No audio track in shared stream. In the share dialog, enable "Share tab audio".'
        );
      }
      audioTracks.forEach((t) => {
        // Browsers may emit ended on track when user stops sharing
        t.addEventListener('ended', () => {
          try { this.mediaRecorder?.state === 'recording' && this.mediaRecorder?.stop(); } catch {}
        });
      });

      this.setupMediaRecorder();
    } catch (error) {
      if ((error as any)?.type) throw error as any;
      throw this.createAudioError('DEVICE_NOT_FOUND', 'Failed to initialize with provided stream', error as Error);
    }
  }

  /**
   * Start recording audio
   */
  async startRecording(onChunk?: (chunk: AudioChunk) => void): Promise<void> {
    if (!this.mediaRecorder) {
      throw this.createAudioError('DEVICE_NOT_FOUND', 'Audio recorder not initialized');
    }

    if (this.mediaRecorder.state === 'recording') {
      return; // Already recording
    }

    this.audioChunks = [];
    this.startTime = Date.now();

    // Set up data handler to collect all chunks
    this.mediaRecorder.ondataavailable = (event) => {
      console.log('Audio chunk received:', {
        size: event.data.size,
        type: event.data.type,
        timestamp: Date.now()
      });
      
      if (event.data.size > 0) {
        this.audioChunks.push(event.data);
        
        // Call onChunk callback if provided
        if (onChunk) {
          const chunk: AudioChunk = {
            data: event.data,
            timestamp: Date.now(),
            duration: Date.now() - this.startTime,
          };
          onChunk(chunk);
        }
      }
    };

    // Set up error handler
    this.mediaRecorder.onerror = (event) => {
      console.error('MediaRecorder error:', event);
    };

    try {
      // Start recording with timeslice to ensure we get data periodically
      this.mediaRecorder.start(this.config.chunkDuration);
      console.log('Recording started with chunk duration:', this.config.chunkDuration);
    } catch (error) {
      throw this.createAudioError('RECORDING_FAILED', 'Failed to start recording', error as Error);
    }
  }

  /**
   * Stop recording and return the complete audio blob
   */
  async stopRecording(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        reject(this.createAudioError('RECORDING_FAILED', 'No active recording to stop'));
        return;
      }

      this.mediaRecorder.onstop = () => {
        console.log('Recording stopped. Total chunks collected:', this.audioChunks.length);
        console.log('Chunk sizes:', this.audioChunks.map(chunk => chunk.size));
        
        const audioBlob = new Blob(this.audioChunks, { type: this.config.mimeType });
        console.log('Final audio blob:', {
          size: audioBlob.size,
          type: audioBlob.type,
          totalChunks: this.audioChunks.length
        });
        
        resolve(audioBlob);
      };

      this.mediaRecorder.onerror = (error) => {
        console.error('Error during recording stop:', error);
        reject(this.createAudioError('RECORDING_FAILED', 'Recording failed', error.error));
      };

      this.mediaRecorder.stop();
    });
  }

  /**
   * Pause recording
   */
  pauseRecording(): void {
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.pause();
    }
  }

  /**
   * Resume recording
   */
  resumeRecording(): void {
    if (this.mediaRecorder && this.mediaRecorder.state === 'paused') {
      this.mediaRecorder.resume();
    }
  }

  /**
   * Get current recording state
   */
  getState(): string {
    return this.mediaRecorder?.state || 'inactive';
  }

  /**
   * Clean up resources
   */
  cleanup(): void {
    if (this.mediaRecorder) {
      this.mediaRecorder.stop();
      this.mediaRecorder = null;
    }
    
    if (this.audioStream) {
      this.audioStream.getTracks().forEach(track => track.stop());
      this.audioStream = null;
    }
    
    this.audioChunks = [];
  }

  private setupMediaRecorder(): void {
    if (!this.audioStream) return;

    // Ensure we have the best supported mime type
    const mimeType = getBestSupportedMimeType();
    this.config.mimeType = mimeType;

    const options: MediaRecorderOptions = {
      mimeType: mimeType,
    };

    // Add bitrate if supported
    if (this.config.bitRate && this.isOptionSupported(mimeType, 'bitsPerSecond')) {
      options.bitsPerSecond = this.config.bitRate;
    }

    console.log('Setting up MediaRecorder with options:', options);
    this.mediaRecorder = new MediaRecorder(this.audioStream, options);
    
    // Log the final configuration
    console.log('MediaRecorder created:', {
      mimeType: this.mediaRecorder.mimeType,
      state: this.mediaRecorder.state,
      streamActive: this.audioStream.active,
      audioTracks: this.audioStream.getAudioTracks().length
    });
  }

  private isOptionSupported(mimeType: string, option: string): boolean {
    try {
      const testOptions = { [option]: 128000 };
      return MediaRecorder.isTypeSupported(mimeType) && 
             new MediaRecorder(new MediaStream(), { mimeType, ...testOptions }) !== null;
    } catch {
      return false;
    }
  }

  private createAudioError(type: AudioError['type'], message: string, originalError?: Error): AudioError {
    return {
      type,
      message,
      originalError,
    };
  }
}
