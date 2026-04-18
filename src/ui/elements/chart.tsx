import {
  LineChart, AreaChart, BarChart, ScatterChart, PieChart,
  Line, Area, Bar, Scatter, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import type { ChartNode, ChartSeries } from '../types'
import { useStateValue } from '../hooks'
import { resolveColor } from '../color'

const DEFAULT_COLORS = [
  'var(--ap-info)',
  'var(--ap-success)',
  'var(--ap-warning)',
  'var(--ap-danger)',
  '#a78bfa',
  '#f97316',
  '#06b6d4',
  '#84cc16',
]

function getColor(series: ChartSeries, idx: number): string {
  return resolveColor(series.color) ?? DEFAULT_COLORS[idx % DEFAULT_COLORS.length]
}

export function ChartElement({ node }: { node: ChartNode }) {
  const data = useStateValue<unknown[]>(node.bind) ?? []
  const chartType = node.chartType ?? 'line'
  const height = node.height ?? 300
  const series: ChartSeries[] = node.series ?? []

  const showGrid = node.grid !== false
  const showTooltip = node.tooltip !== false
  const showLegend = node.legend !== false

  if (chartType === 'pie') {
    const nameKey = node.nameKey ?? 'name'
    const valueKey = node.valueKey ?? 'value'
    const innerRadius = node.donut ? '55%' : 0

    return (
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          {showTooltip && <Tooltip />}
          {showLegend && <Legend />}
          <Pie
            data={data as Record<string, unknown>[]}
            dataKey={valueKey}
            nameKey={nameKey}
            innerRadius={innerRadius}
            outerRadius="80%"
            paddingAngle={2}
          >
            {(data as Record<string, unknown>[]).map((_, i) => (
              <Cell key={i} fill={DEFAULT_COLORS[i % DEFAULT_COLORS.length]} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
    )
  }

  const xKey = node.xKey ?? 'x'

  if (chartType === 'scatter') {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <ScatterChart>
          {showGrid && <CartesianGrid strokeDasharray="3 3" stroke="var(--ap-border)" />}
          <XAxis dataKey={xKey} stroke="var(--ap-text-dim)" tick={{ fontSize: 11 }} />
          <YAxis stroke="var(--ap-text-dim)" tick={{ fontSize: 11 }} />
          {showTooltip && <Tooltip />}
          {showLegend && <Legend />}
          {series.map((s, i) => (
            <Scatter key={s.key} name={s.label ?? s.key} data={data as Record<string, unknown>[]} fill={getColor(s, i)} />
          ))}
        </ScatterChart>
      </ResponsiveContainer>
    )
  }

  if (chartType === 'bar') {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data as Record<string, unknown>[]}>
          {showGrid && <CartesianGrid strokeDasharray="3 3" stroke="var(--ap-border)" />}
          <XAxis dataKey={xKey} stroke="var(--ap-text-dim)" tick={{ fontSize: 11 }} />
          <YAxis stroke="var(--ap-text-dim)" tick={{ fontSize: 11 }} />
          {showTooltip && <Tooltip />}
          {showLegend && <Legend />}
          {series.map((s, i) => (
            <Bar key={s.key} dataKey={s.key} name={s.label ?? s.key} fill={getColor(s, i)} stackId={node.stacked ? 'stack' : undefined} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    )
  }

  if (chartType === 'area') {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data as Record<string, unknown>[]}>
          {showGrid && <CartesianGrid strokeDasharray="3 3" stroke="var(--ap-border)" />}
          <XAxis dataKey={xKey} stroke="var(--ap-text-dim)" tick={{ fontSize: 11 }} />
          <YAxis stroke="var(--ap-text-dim)" tick={{ fontSize: 11 }} />
          {showTooltip && <Tooltip />}
          {showLegend && <Legend />}
          {series.map((s, i) => {
            const color = getColor(s, i)
            return (
              <Area
                key={s.key}
                type={node.smooth ? 'monotone' : 'linear'}
                dataKey={s.key}
                name={s.label ?? s.key}
                stroke={color}
                fill={color}
                fillOpacity={0.2}
                stackId={node.stacked ? 'stack' : undefined}
              />
            )
          })}
        </AreaChart>
      </ResponsiveContainer>
    )
  }

  // default: line
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data as Record<string, unknown>[]}>
        {showGrid && <CartesianGrid strokeDasharray="3 3" stroke="var(--ap-border)" />}
        <XAxis dataKey={xKey} stroke="var(--ap-text-dim)" tick={{ fontSize: 11 }} />
        <YAxis stroke="var(--ap-text-dim)" tick={{ fontSize: 11 }} />
        {showTooltip && <Tooltip />}
        {showLegend && <Legend />}
        {series.map((s, i) => (
          <Line
            key={s.key}
            type={node.smooth ? 'monotone' : 'linear'}
            dataKey={s.key}
            name={s.label ?? s.key}
            stroke={getColor(s, i)}
            dot={false}
            isAnimationActive={true}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}
