import React, { useMemo } from 'react';
import { TranscriptSegment } from '../../types/transcript';
import { MessageBubble } from './MessageBubble';

interface ChatThreadProps {
  micSegments: TranscriptSegment[];
  shareSegments: TranscriptSegment[];
}

/**
 * Merge per-source segments by startTime and render as chat bubbles.
 */
export const ChatThread: React.FC<ChatThreadProps> = ({ micSegments, shareSegments }) => {
  const merged = useMemo(() => {
    const tag = (arr: TranscriptSegment[], tag: 'mic' | 'share') =>
      arr.map(s => ({ ...s, sourceId: tag } as TranscriptSegment));
    const combined = [...tag(micSegments, 'mic'), ...tag(shareSegments, 'share')];
    const ordered = combined
      .filter(s => s.text && s.text.trim().length > 0)
      .sort((a, b) => a.startTime - b.startTime || a.timestamp - b.timestamp);

    // Collapse consecutive duplicates (same source + same text)
    const deduped: TranscriptSegment[] = [];
    for (const seg of ordered) {
      const last = deduped[deduped.length - 1];
      if (last && last.sourceId === seg.sourceId && last.text.trim() === seg.text.trim()) {
        // merge time bounds to the latest end
        last.endTime = Math.max(last.endTime, seg.endTime);
        continue;
      }
      deduped.push({ ...seg });
    }
    return deduped;
  }, [micSegments, shareSegments]);

  if (merged.length === 0) {
    return (
      <div className="p-4 text-center text-gray-500 text-sm">No messages yet</div>
    );
  }

  return (
    <div className="space-y-2 max-h-96 overflow-y-auto p-2 bg-white rounded-lg border">
      {merged.map(m => (
        <MessageBubble key={m.id} segment={m} />
      ))}
    </div>
  );
};
