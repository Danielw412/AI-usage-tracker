import { compact, modelLabel, usd } from '../format';
import type { ModelEfficiency, ModelUsageSummary } from '../types';

interface ModelLedgerProps {
  usage: ModelUsageSummary[];
  efficiency: ModelEfficiency[];
}

type StackKey = 'cached' | 'cacheWrites' | 'uncached' | 'output';

const STACK: Array<{ key: StackKey; label: string; color: string }> = [
  { key: 'cached', label: 'Cached input', color: 'var(--ramp-1)' },
  { key: 'cacheWrites', label: 'Cache writes', color: 'var(--ramp-4)' },
  { key: 'uncached', label: 'Fresh input', color: 'var(--ramp-2)' },
  { key: 'output', label: 'Output', color: 'var(--ramp-3)' }
];

export function ModelLedger({ usage, efficiency }: ModelLedgerProps) {
  const efficiencyByModel = new Map(efficiency.map((row) => [row.model, row]));
  const rows = usage
    .filter((row) => row.model !== 'unknown')
    .slice(0, 8)
    .map((row) => {
      const cacheWrites = Math.max(0, row.cacheWriteInputTokens ?? 0);
      return {
        ...row,
        cached: row.cachedInputTokens,
        cacheWrites,
        uncached: Math.max(0, row.inputTokens - row.cachedInputTokens - cacheWrites),
        output: row.outputTokens,
        efficiency: efficiencyByModel.get(row.model) ?? null
      };
    });
  // Providers that do not bill cache writes separately keep the original three-part stack.
  const showCacheWrites = rows.some((row) => row.cacheWrites > 0);
  const stack = STACK.filter((item) => item.key !== 'cacheWrites' || showCacheWrites);
  const maxTokens = Math.max(1, ...rows.map((row) => row.totalTokens));
  const bestTokensPerPercent = Math.max(0, ...rows.map((row) => row.efficiency?.tokensPerPercent ?? 0));

  return (
    <section className="panel ledger-panel" aria-labelledby="ledger-title">
      <header className="panel-head">
        <div>
          <h3 id="ledger-title">Models</h3>
          <p>Tokens, API-equivalent price, and how far each model stretches the quota</p>
        </div>
        <ul className="stack-legend" aria-label="Token stack legend">
          {stack.map((item) => (
            <li key={item.key}><i style={{ background: item.color }} aria-hidden="true" />{item.label}</li>
          ))}
        </ul>
      </header>

      {rows.length === 0 ? (
        <div className="chart-empty">No model activity has been indexed.</div>
      ) : (
        <div className="ledger-scroll">
          <table className="ledger">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col" className="ledger-tokens">Tokens</th>
                <th scope="col" className="num">API equivalent</th>
                <th scope="col" className="num" title="How many five-hour windows of quota this model consumed over the last 15 days">Windows used</th>
                <th scope="col" className="num" title="Tokens processed for each 1% of a 5-hour window">Tokens per 1%</th>
                <th scope="col" className="num" title="Active task minutes for each 1% of a 5-hour window">Minutes per 1%</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const tokensPerPercent = row.efficiency?.tokensPerPercent ?? null;
                const isBest = tokensPerPercent !== null && tokensPerPercent === bestTokensPerPercent && rows.length > 1;
                return (
                  <tr key={row.model}>
                    <th scope="row">
                      <span className="ledger-model">{modelLabel(row.model)}</span>
                      <span className="ledger-sub">{row.threads} {row.threads === 1 ? 'chat' : 'chats'}</span>
                    </th>
                    <td className="ledger-tokens">
                      <div className="ledger-tokens-inner">
                        <div className="stack-track">
                          <div className="stack-bar" style={{ width: `${Math.max(1.5, (row.totalTokens / maxTokens) * 100)}%` }}>
                            {stack.map((item) => (
                              <span
                                key={item.key}
                                style={{ flexGrow: row[item.key], background: item.color }}
                                title={`${item.label}: ${compact(row[item.key])}`}
                              />
                            ))}
                          </div>
                        </div>
                        <span className="ledger-value">{compact(row.totalTokens)}</span>
                      </div>
                    </td>
                    <td className="num">{row.estimatedApiCostUsd > 0 ? usd(row.estimatedApiCostUsd) : <span className="muted">no price</span>}</td>
                    <td className="num">
                      {row.efficiency ? (row.efficiency.estimatedUsagePercent / 100).toFixed(1) : <span className="muted">-</span>}
                    </td>
                    <td className={`num ${isBest ? 'is-best' : ''}`}>
                      {tokensPerPercent !== null ? compact(tokensPerPercent, 1) : <span className="muted">-</span>}
                    </td>
                    <td className="num">
                      {row.efficiency?.minutesPerPercent != null ? row.efficiency.minutesPerPercent.toFixed(2) : <span className="muted">-</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="panel-foot">
        Quota columns use 5-hour windows from the last 15 days. A higher tokens-per-1% figure means the model is cheaper on your limit.
      </p>
    </section>
  );
}
