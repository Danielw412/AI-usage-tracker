import { ArrowUpRight } from 'lucide-react';
import { percent, relativeTime } from '../format';
import type { ProviderCopy } from '../providers';
import type { DashboardOverview } from '../types';

interface CloudTasksProps {
  cloud: DashboardOverview['cloudTasks'];
  breakdown: DashboardOverview['breakdown'];
  copy: ProviderCopy;
  now: number;
}

function statusTone(status: string): string {
  if (/ready|done|complete|merged|success/.test(status)) return 'done';
  if (/error|fail|cancel/.test(status)) return 'failed';
  if (/pending|running|queue|progress|in progress/.test(status)) return 'active';
  return 'neutral';
}

export function CloudTasks({ cloud, breakdown, copy, now }: CloudTasksProps) {
  const five = breakdown.fiveHour;
  const seven = breakdown.sevenDay;
  const text = copy.cloud;
  const subtitle = cloud.status === 'available'
    ? cloud.checkedAt ? `Checked ${relativeTime(cloud.checkedAt, now * 1000)} ${text.checkedVia}` : text.source
    : cloud.status === 'disabled'
      ? 'Cloud polling is turned off'
      : cloud.status === 'unsupported'
        ? 'Not available for this provider'
        : text.unavailable;
  const emptyText = cloud.status === 'available'
    ? text.noTasks
    : cloud.status === 'unsupported'
      ? text.unsupportedBody
      : text.checkAccess;

  return (
    <section className="section" id="cloud" aria-labelledby="cloud-title">
      <header className="section-head">
        <h2 id="cloud-title">{text.sectionTitle}</h2>
        <p>{text.sectionBody}</p>
      </header>

      <div className="cloud-grid">
        <div className="panel unattributed-panel">
          <h3>Unattributed usage</h3>
          <div className="unattributed-figures">
            <div>
              <span className="stat-label">This 5-hour window</span>
              <span className="stat-value">{five ? percent(five.unattributedPercent) : '-'}</span>
              <span className="stat-note">
                {five && five.observedDeltaPercent > 0
                  ? `of ${percent(five.observedDeltaPercent)} observed`
                  : 'no samples yet'}
              </span>
            </div>
            <div>
              <span className="stat-label">This 7-day window</span>
              <span className="stat-value">{seven ? percent(seven.unattributedPercent) : '-'}</span>
              <span className="stat-note">
                {seven && seven.observedDeltaPercent > 0
                  ? `of ${percent(seven.observedDeltaPercent)} observed`
                  : 'no samples yet'}
              </span>
            </div>
          </div>
          <p className="panel-foot">
            Counted whenever the reported percentage climbs while no local chat has logged tokens since the previous rise.
          </p>
        </div>

        <div className="panel cloud-list-panel">
          <header className="panel-head">
            <div>
              <h3>{text.listTitle}</h3>
              <p>{subtitle}</p>
            </div>
          </header>
          {cloud.tasks.length === 0 ? (
            <div className="chart-empty">{emptyText}</div>
          ) : (
            <ul className="cloud-list">
              {cloud.tasks.map((task) => (
                <li key={task.id}>
                  <div className="cloud-task-main">
                    <span className="cloud-task-title">
                      {task.url ? (
                        <a href={task.url} target="_blank" rel="noreferrer">
                          {task.title} <ArrowUpRight size={13} strokeWidth={1.75} aria-hidden="true" />
                        </a>
                      ) : task.title}
                    </span>
                    <span className="cloud-task-meta">
                      {task.environmentLabel ? <span>{task.environmentLabel}</span> : null}
                      {task.isReview ? <span>review</span> : null}
                      {task.filesChanged !== null ? (
                        <span>
                          {task.filesChanged} {task.filesChanged === 1 ? 'file' : 'files'}
                          {task.linesAdded !== null ? `, +${task.linesAdded}` : ''}
                          {task.linesRemoved !== null ? ` / -${task.linesRemoved}` : ''}
                        </span>
                      ) : null}
                    </span>
                  </div>
                  <span className={`status-tag ${statusTone(task.status)}`}>{task.status}</span>
                  <span className="cloud-task-time">{relativeTime(task.updatedAt ?? task.firstSeenAt, now * 1000)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
