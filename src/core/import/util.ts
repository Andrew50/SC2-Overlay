export function parseTimeToSeconds(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 60;
  }
  const parts = trimmed.split(":");
  if (parts.length === 2 && parts.every((entry) => /^\d+$/.test(entry.trim()))) {
    return Number(parts[0]) * 60 + Number(parts[1]);
  }
  return undefined;
}

export function formatSeconds(totalSeconds: number): string {
  const bounded = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(bounded / 60).toString();
  const seconds = (bounded % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function isTimeToken(token: string): boolean {
  return /^\d{1,2}:\d{2}$/.test(token.trim());
}

export function isIntegerToken(token: string): boolean {
  return /^\d+$/.test(token.trim());
}
