import { WizperResponse, WizperError } from '../types/transcript';
import { API_CONFIG } from '../utils/constants';
import { fal } from '@fal-ai/client';

// NOTE: Deprecated in favor of GroqSTT (see src/services/groqSTT.ts)
// Keeping this file for reference/testing. New code should use GroqSTT.

export interface WizperConfig {
  apiKey: string;
  language?: string;
  task?: 'transcribe' | 'translate';
  enableTimestamps?: boolean;
}

export class WizperAPI {
  private config: WizperConfig;
  private retryCount: number = 0;

  constructor(config: WizperConfig) {
    this.config = {
      task: 'transcribe',
      enableTimestamps: true,
      ...config,
    };

    // Configure fal.ai client
    fal.config({
      credentials: this.config.apiKey,
    });
  }

  /**
   * Transcribe audio using fal.ai Wizper API with proper file upload
   */
  async transcribe(audioBlob: Blob): Promise<WizperResponse> {
    try {
      // Validate audio blob
      if (audioBlob.size === 0) {
        throw new Error('Audio blob is empty. Please ensure microphone is working and audio is being captured.');
      }

      if (audioBlob.size > API_CONFIG.MAX_FILE_SIZE) {
        throw new Error(`File size exceeds maximum limit of ${API_CONFIG.MAX_FILE_SIZE / (1024 * 1024)}MB`);
      }

      console.log('Attempting to transcribe audio blob:', {
        size: audioBlob.size,
        type: audioBlob.type
      });

      // Create a File object from the blob
      const audioFile = new File([audioBlob], 'recording.webm', { 
        type: audioBlob.type || 'audio/webm;codecs=opus' 
      });

      console.log('Uploading audio file to fal.ai storage...');

      // Use fal.ai client to upload the file and transcribe
      const result = await fal.subscribe('fal-ai/wizper', {
        input: {
          audio_url: audioFile,  // fal.ai client will handle the upload automatically
          task: this.config.task || 'transcribe',
          language: this.config.language,
          chunk_level: 'segment',
          version: '3'
        },
        logs: true,
        onQueueUpdate: (update) => {
          console.log('Queue update:', update.status);
          // Handle logs only for completed status when they're available
          if (update.status === 'COMPLETED' && 'logs' in update) {
            const logs = (update as any).logs;
            if (logs) {
              logs.forEach((log: any) => console.log('Log:', log.message));
            }
          }
        }
      });

      console.log('Transcription completed:', result);
      return this.parseResponse(result);
    } catch (error) {
      if (this.retryCount < API_CONFIG.MAX_RETRIES) {
        this.retryCount++;
        console.warn(`Transcription failed, retrying... (${this.retryCount}/${API_CONFIG.MAX_RETRIES})`);
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second between retries
        return this.transcribe(audioBlob);
      }
      throw this.createWizperError(error);
    }
  }

  /**
   * Transcribe audio from URL (for existing files)
   */
  async transcribeFromUrl(audioUrl: string): Promise<WizperResponse> {
    try {
      const result = await fal.subscribe('fal-ai/wizper', {
        input: {
          audio_url: audioUrl,
          task: this.config.task || 'transcribe',
          language: this.config.language,
          chunk_level: 'segment',
          version: '3'
        }
      });

      return this.parseResponse(result);
    } catch (error) {
      throw this.createWizperError(error);
    }
  }

  /**
   * Check API health/connectivity
   */
  async healthCheck(): Promise<boolean> {
    try {
      // Simple test to verify API key and connectivity
      await fal.run('fal-ai/wizper', {
        input: {
          audio_url: 'https://github.com/ggerganov/whisper.cpp/raw/master/samples/jfk.wav',
          task: 'transcribe',
          language: 'en',
          chunk_level: 'segment',
          version: '3'
        }
      });
      return true;
    } catch (error) {
      console.warn('Wizper API health check failed:', error);
      return false;
    }
  }

  private parseResponse(response: any): WizperResponse {
    // Reset retry count on successful response
    this.retryCount = 0;

    if (response.error) {
      throw new Error(response.error);
    }

    // Map the response format to our expected format
    const segments = response.chunks?.map((chunk: any) => ({
      text: chunk.text,
      start: chunk.timestamp?.[0] || 0,
      end: chunk.timestamp?.[1] || 0,
      confidence: 0.9, // fal.ai doesn't provide confidence scores, so we use a default
    })) || [];

    return {
      text: response.text || '',
      segments,
      language: response.language,
      duration: segments.length > 0 ? segments[segments.length - 1].end : 0,
    };
  }

  private createWizperError(error: any): WizperError {
    let message = 'Unknown error occurred';
    let statusCode: number | undefined;

    if (error instanceof Error) {
      message = error.message;
    } else if (typeof error === 'string') {
      message = error;
    } else if (error.detail) {
      message = error.detail;
      statusCode = error.status_code;
    }

    return {
      error: 'TRANSCRIPTION_FAILED',
      message,
      statusCode,
    };
  }

  /**
   * Update API configuration
   */
  updateConfig(newConfig: Partial<WizperConfig>): void {
    this.config = { ...this.config, ...newConfig };
    
    // Update fal.ai client configuration if API key changed
    if (newConfig.apiKey) {
      fal.config({
        credentials: newConfig.apiKey,
      });
    }
  }
}
