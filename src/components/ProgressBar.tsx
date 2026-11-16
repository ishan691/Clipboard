interface Props { progress: number; label?: string; }
export function ProgressBar({ progress, label = 'Upload progress' }: Props) {
  return <div className="progress-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}>
    <div style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
  </div>;
}
