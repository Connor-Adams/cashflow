import { Line, LineChart, ResponsiveContainer } from 'recharts'

export type SparklinePoint = { date: string; value: number }
export type SparklineProps = {
  data: SparklinePoint[]
  width?: number
  height?: number
}

export function Sparkline({ data, width = 80, height = 24 }: SparklineProps) {
  if (data.length < 2) return null
  const up = data[data.length - 1].value >= data[0].value
  const stroke = up ? 'var(--accent-positive)' : 'var(--accent-warm)'
  return (
    <div style={{ width, height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <Line
            type="monotone"
            dataKey="value"
            stroke={stroke}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
