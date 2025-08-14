import React from 'react';

interface ConfidenceIndicatorProps {
  confidence: number;
  size?: 'small' | 'medium' | 'large';
  showText?: boolean;
}

export const ConfidenceIndicator: React.FC<ConfidenceIndicatorProps> = ({
  confidence,
  size = 'medium',
  showText = false,
}) => {
  const getConfidenceColor = () => {
    if (confidence >= 0.8) return 'bg-green-500';
    if (confidence >= 0.6) return 'bg-yellow-500';
    return 'bg-red-500';
  };

  const getConfidenceText = () => {
    if (confidence >= 0.8) return 'High';
    if (confidence >= 0.6) return 'Medium';
    return 'Low';
  };

  const getSizeClasses = () => {
    switch (size) {
      case 'small': return 'w-12 h-1.5';
      case 'large': return 'w-20 h-3';
      default: return 'w-16 h-2';
    }
  };

  return (
    <div className="flex items-center space-x-2">
      <div className={`bg-gray-200 rounded-full ${getSizeClasses()}`}>
        <div
          className={`h-full rounded-full transition-all duration-300 ${getConfidenceColor()}`}
          style={{ width: `${confidence * 100}%` }}
        />
      </div>
      {showText && (
        <span className={`text-gray-600 ${size === 'small' ? 'text-xs' : 'text-sm'}`}>
          {getConfidenceText()} ({Math.round(confidence * 100)}%)
        </span>
      )}
    </div>
  );
};
