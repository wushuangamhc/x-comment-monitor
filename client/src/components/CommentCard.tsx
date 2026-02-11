import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Heart, MessageSquare, Clock, ExternalLink } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { zhCN } from "date-fns/locale";

interface CommentCardProps {
  comment: {
    replyId: string;
    authorName: string;
    authorHandle: string;
    text: string;
    createdAt: Date | string;
    likeCount: number;
    replyTo?: string | null;
    replyToText?: string | null;
    sentiment?: string | null;
    valueScore?: string | null;
    summary?: string | null;
  };
}

const SENTIMENT_STYLES: Record<string, { label: string; className: string }> = {
  positive: { label: '支持', className: 'sentiment-positive' },
  neutral: { label: '中立', className: 'sentiment-neutral' },
  negative: { label: '批评', className: 'sentiment-negative' },
  anger: { label: '愤怒', className: 'sentiment-anger' },
  sarcasm: { label: '讽刺', className: 'sentiment-sarcasm' },
};

export function CommentCard({ comment }: CommentCardProps) {
  const valueScore = comment.valueScore ? parseFloat(comment.valueScore) : null;
  const isHighValue = valueScore !== null && valueScore >= 0.7;
  const isLowValue = valueScore !== null && valueScore < 0.4;
  const sentimentStyle = comment.sentiment ? SENTIMENT_STYLES[comment.sentiment] : null;

  const timeAgo = formatDistanceToNow(new Date(comment.createdAt), {
    addSuffix: true,
    locale: zhCN,
  });

  return (
    <Card className={`transition-all hover:shadow-md ${isHighValue ? 'value-high' : ''} ${isLowValue ? 'value-low' : ''}`}>
      <CardContent className="p-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center flex-shrink-0">
              <span className="text-sm font-medium">
                {comment.authorName?.charAt(0)?.toUpperCase() || '?'}
              </span>
            </div>
            <div className="min-w-0">
              <div className="font-medium text-sm truncate">{comment.authorName}</div>
              <div className="text-xs text-muted-foreground">@{comment.authorHandle}</div>
            </div>
          </div>
          
          <div className="flex items-center gap-2 flex-shrink-0">
            {sentimentStyle && (
              <Badge variant="secondary" className={`text-xs ${sentimentStyle.className}`}>
                {sentimentStyle.label}
              </Badge>
            )}
            {valueScore !== null && (
              <Badge 
                variant={isHighValue ? "default" : "outline"} 
                className={`text-xs ${isHighValue ? 'bg-green-600' : ''}`}
              >
                {valueScore.toFixed(2)}
              </Badge>
            )}
          </div>
        </div>

        {/* Content */}
        <p className="text-sm leading-relaxed mb-3 whitespace-pre-wrap">
          {comment.text}
        </p>

        {/* AI Summary */}
        {comment.summary && (
          <div className="bg-secondary/50 rounded-md px-3 py-2 mb-3">
            <p className="text-xs text-muted-foreground mb-1">AI 摘要</p>
            <p className="text-sm">{comment.summary}</p>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <div className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {timeAgo}
          </div>
          <div className="flex items-center gap-1">
            <Heart className="w-3 h-3" />
            {comment.likeCount}
          </div>
          {comment.replyTo && (
            <a 
              href={`https://x.com/i/status/${comment.replyTo}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 hover:text-primary transition-colors ml-auto text-xs text-muted-foreground max-w-[400px]"
              title={comment.replyToText || "查看原推文"}
            >
              <ExternalLink className="w-3 h-3 flex-shrink-0" />
              <span className="truncate">
                回复: {comment.replyToText ? (comment.replyToText.length > 50 ? comment.replyToText.slice(0, 50) + '...' : comment.replyToText) : '推文'}
              </span>
            </a>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
