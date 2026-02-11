import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, PieChart, Pie, Cell, Legend
} from "recharts";

interface AnalyticsPanelProps {
  stats: {
    totalComments: number;
    analyzedComments: number;
    sentimentCounts: Record<string, number>;
    valueDistribution: number[];
    sentimentOverTime: Array<Record<string, any>>;
  };
}

const SENTIMENT_COLORS: Record<string, string> = {
  positive: '#22c55e',
  neutral: '#64748b',
  negative: '#f97316',
  anger: '#ef4444',
  sarcasm: '#a855f7',
};

const SENTIMENT_LABELS: Record<string, string> = {
  positive: '支持',
  neutral: '中立',
  negative: '批评',
  anger: '愤怒',
  sarcasm: '讽刺',
};

export function AnalyticsPanel({ stats }: AnalyticsPanelProps) {
  // Prepare pie chart data
  const pieData = Object.entries(stats.sentimentCounts)
    .filter(([_, count]) => count > 0)
    .map(([sentiment, count]) => ({
      name: SENTIMENT_LABELS[sentiment] || sentiment,
      value: count,
      color: SENTIMENT_COLORS[sentiment] || '#888',
    }));

  // Prepare value distribution data
  const valueData = stats.valueDistribution.map((count, index) => ({
    range: `${(index / 10).toFixed(1)}-${((index + 1) / 10).toFixed(1)}`,
    count,
    label: index >= 7 ? '高价值' : index >= 4 ? '中等' : '噪音',
  }));

  // Format time for chart
  const timeData = stats.sentimentOverTime.map(item => ({
    ...item,
    time: item.time.slice(11, 16), // Extract HH:MM
  }));

  // Fetch opinion clusters
  const generateClusters = trpc.analysis.generateClusters.useMutation();
  const opinionData = generateClusters.data;

  return (
    <div className="p-4 bg-card/30">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Sentiment Distribution */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">情绪分布</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={40}
                    outerRadius={70}
                    paddingAngle={2}
                    dataKey="value"
                  >
                    {pieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip 
                    formatter={(value: number) => [`${value} 条`, '数量']}
                  />
                  <Legend 
                    verticalAlign="bottom" 
                    height={36}
                    formatter={(value) => <span className="text-xs">{value}</span>}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* Value Distribution */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">价值分布</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={valueData}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis 
                    dataKey="range" 
                    tick={{ fontSize: 10 }}
                    interval={1}
                  />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip 
                    formatter={(value: number) => [`${value} 条`, '数量']}
                    labelFormatter={(label) => `评分区间: ${label}`}
                  />
                  <Bar 
                    dataKey="count" 
                    fill="#6366f1"
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* Sentiment Trend */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">情绪趋势</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-48">
              {timeData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={timeData}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                    <XAxis 
                      dataKey="time" 
                      tick={{ fontSize: 10 }}
                    />
                    <YAxis tick={{ fontSize: 10 }} />
                    <Tooltip />
                    <Area 
                      type="monotone" 
                      dataKey="positive" 
                      stackId="1"
                      stroke={SENTIMENT_COLORS.positive}
                      fill={SENTIMENT_COLORS.positive}
                      fillOpacity={0.6}
                      name="支持"
                    />
                    <Area 
                      type="monotone" 
                      dataKey="neutral" 
                      stackId="1"
                      stroke={SENTIMENT_COLORS.neutral}
                      fill={SENTIMENT_COLORS.neutral}
                      fillOpacity={0.6}
                      name="中立"
                    />
                    <Area 
                      type="monotone" 
                      dataKey="negative" 
                      stackId="1"
                      stroke={SENTIMENT_COLORS.negative}
                      fill={SENTIMENT_COLORS.negative}
                      fillOpacity={0.6}
                      name="批评"
                    />
                    <Area 
                      type="monotone" 
                      dataKey="anger" 
                      stackId="1"
                      stroke={SENTIMENT_COLORS.anger}
                      fill={SENTIMENT_COLORS.anger}
                      fillOpacity={0.6}
                      name="愤怒"
                    />
                    <Area 
                      type="monotone" 
                      dataKey="sarcasm" 
                      stackId="1"
                      stroke={SENTIMENT_COLORS.sarcasm}
                      fill={SENTIMENT_COLORS.sarcasm}
                      fillOpacity={0.6}
                      name="讽刺"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
                  暂无趋势数据
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Opinion Clusters */}
      {opinionData?.clusters && opinionData.clusters.length > 0 && (
        <Card className="mt-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">主要观点聚类</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {opinionData.clusters.map((cluster: any, index: number) => (
                <div 
                  key={index}
                  className="p-3 rounded-lg bg-secondary/50 border"
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-medium text-sm">{cluster.name}</span>
                    <span className="text-xs text-muted-foreground">
                      约 {cluster.percentage}%
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mb-2">
                    {cluster.description}
                  </p>
                  {cluster.representativeComment && (
                    <div className="text-xs bg-background/50 rounded p-2 italic">
                      "{cluster.representativeComment.text?.slice(0, 100)}..."
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
