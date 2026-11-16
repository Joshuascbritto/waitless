import { activeHourSpan, type PeakHourCell, toHeatmapGrid, WEEKDAY_LABELS } from "@waitless/shared";

/** One-hue sequential ramp (blue 150 → 650); zero gets the neutral surface. */
const STEPS = ["#b7d3f6", "#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#104281"] as const;
const EMPTY = "#f5f5f4";

function cellColor(value: number, max: number): string {
  if (value === 0 || max === 0) return EMPTY;
  const index = Math.min(STEPS.length - 1, Math.floor((value / max) * STEPS.length));
  return STEPS[index] ?? EMPTY;
}

/**
 * Joins by local weekday × hour. Plain CSS grid rendered on the server: no
 * chart library needed, and each cell carries its number for hover and
 * screen readers. Hours are trimmed to the span that has any joins.
 */
export function PeakHoursHeatmap({ cells }: { cells: PeakHourCell[] }) {
  const { grid, max } = toHeatmapGrid(cells);
  const { first, last } = activeHourSpan(grid);
  const hours = Array.from({ length: last - first + 1 }, (_, i) => first + i);

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0.5 text-xs">
          <caption className="sr-only">Customers who joined, by weekday and hour</caption>
          <thead>
            <tr>
              <th scope="col" className="w-10" />
              {hours.map((hour) => (
                <th key={hour} scope="col" className="min-w-7 pb-1 font-normal text-neutral-500">
                  {hour}h
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {WEEKDAY_LABELS.map((label, row) => (
              <tr key={label}>
                <th scope="row" className="pr-2 text-left font-normal text-neutral-500">
                  {label}
                </th>
                {hours.map((hour) => {
                  const value = grid[row]?.[hour] ?? 0;
                  const text = `${label} ${hour}:00–${hour + 1}:00: ${value} joined`;
                  return (
                    <td
                      key={hour}
                      title={text}
                      className="h-7 rounded-sm"
                      style={{ backgroundColor: cellColor(value, max) }}
                    >
                      <span className="sr-only">{text}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 text-xs text-neutral-500" aria-hidden="true">
        <span>Fewer</span>
        {[EMPTY, ...STEPS].map((color) => (
          <span key={color} className="h-3 w-5 rounded-sm" style={{ backgroundColor: color }} />
        ))}
        <span>More (max {max} in one hour)</span>
      </div>
    </div>
  );
}
