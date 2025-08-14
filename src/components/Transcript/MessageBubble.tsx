import React from 'react';
import { TranscriptSegment } from '../../types/transcript';

interface MessageBubbleProps {
  segment: TranscriptSegment;
}

export const MessageBubble: React.FC<MessageBubbleProps> = ({ segment }) => {
  const isMic = segment.sourceId === 'mic';
  const bubbleColor = isMic ? 'bg-gray-200 text-gray-900' : 'bg-blue-600 text-white';
  const align = isMic ? 'items-start' : 'items-end';

  return (
    <div className={`w-full flex ${align}`}>
      <div
        className={`max-w-[80%] px-3 py-2 rounded-2xl shadow-sm ${bubbleColor} ${
          isMic ? 'rounded-tl-sm' : 'rounded-tr-sm'
        }`}
      >
        <p className={`text-sm ${segment.isProcessing ? 'opacity-70 italic' : ''}`}>
          {segment.text}
        </p>
      </div>
    </div>
  );
};
