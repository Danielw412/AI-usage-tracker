import { countdown, percent } from '../format';
import type { RateLimitWindow } from '../types';

interface ExtraLimitsProps {
  windows: RateLimitWindow[];
  now: number;
}

/** Compact chips for windows beyond the 5-hour and 7-day pair, such as model-specific caps. */
export function ExtraLimits({ windows, now }: ExtraLimitsProps) {
  if (windows.length === 0) return null;

  return (
    <ul className="extra-limits" aria-label="Additional limits">
      {windows.map((window) => {
        const used = window.usedPercent;
        const over = used > 100;
        const secondsToReset = window.resetsAt > 0 ? window.resetsAt - now : 0;
        const reset = secondsToReset > 0 ? `resets in ${countdown(secondsToReset)}` : 'reset pending';
        return (
          <li key={window.key} className={`extra-limit ${over ? 'is-over' : ''}`}>
            <span className="extra-limit-label" title={window.label}>{window.label}</span>
            <span className="extra-limit-value">{percent(used)}</span>
            <span
              className="extra-limit-meter"
              role="meter"
              aria-label={`${window.label} usage`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.min(100, Math.max(0, used))}
              aria-valuetext={`${percent(used)} used`}
            >
              <i style={{ width: `${Math.min(100, Math.max(0, used))}%` }} />
            </span>
            <span className="extra-limit-reset">{reset}</span>
          </li>
        );
      })}
    </ul>
  );
}
