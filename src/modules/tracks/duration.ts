export function parseDuration(value: string): number | null {
  const input = value.trim();
  if (!input) return null;
  const parts = input.split(":");
  if (parts.length !== 2 && parts.length !== 3) throw new Error("Use MM:SS or HH:MM:SS.");
  if (!parts.every((part) => /^\d{2}$/.test(part))) throw new Error("Use two digits per duration segment.");
  const values = parts.map(Number);
  const [hours, minutes, seconds] = parts.length === 3 ? values : [0, ...values];
  if (seconds! > 59 || (parts.length === 3 && minutes! > 59)) throw new Error("Minutes and seconds must be below 60.");
  return ((hours! * 60 * 60) + (minutes! * 60) + seconds!) * 1000;
}

export function formatDuration(milliseconds: number | null): string | null {
  if (milliseconds === null) return null;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new Error("Duration must be non-negative whole milliseconds.");
  const totalSeconds = Math.floor(milliseconds / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(totalMinutes)}:${pad(seconds)}`;
}

export function formatLegacyDuration(milliseconds: number | null): string | null {
  if (milliseconds === null) return null;
  const totalSeconds = Math.floor(milliseconds / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}
