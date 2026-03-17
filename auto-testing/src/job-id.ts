export function generateJobId(): string {
  return `job-${Date.now()}-${Math.random().toString(36).substring(7)}`;
}

export function getJobTimestamp(jobId: string): number | null {
  const match = /^job-(\d+)-/.exec(jobId);
  if (!match) return null;
  const timestamp = Number(match[1]);
  return Number.isFinite(timestamp) ? timestamp : null;
}
