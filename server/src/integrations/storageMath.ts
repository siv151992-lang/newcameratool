import type { StorageDeviceStatus, StorageReading } from "./types.js";

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Fills used bytes / percentage for one device from total and free, if both are valid. */
export function completeDevice(d: StorageDeviceStatus): StorageDeviceStatus {
  const out = { ...d };
  if (out.totalBytes !== undefined && out.freeBytes !== undefined) {
    if (out.freeBytes > out.totalBytes) {
      // Inconsistent reading: keep the raw numbers but do not invent a usage figure.
      out.usedBytes = undefined;
      out.usedPercentage = undefined;
    } else {
      out.usedBytes = out.totalBytes - out.freeBytes;
      out.usedPercentage = out.totalBytes > 0 ? round2((out.usedBytes / out.totalBytes) * 100) : undefined;
    }
  }
  return out;
}

/** Aggregates capacity across devices that report both total and free space consistently. */
export function aggregate(devices: StorageDeviceStatus[]): StorageReading {
  const completed = devices.map(completeDevice);
  const measurable = completed.filter((d) => d.totalBytes !== undefined && d.usedBytes !== undefined);
  if (measurable.length === 0) return { devices: completed };
  const totalBytes = measurable.reduce((s, d) => s + d.totalBytes!, 0);
  const freeBytes = measurable.reduce((s, d) => s + d.freeBytes!, 0);
  const usedBytes = totalBytes - freeBytes;
  return {
    devices: completed,
    totalBytes,
    freeBytes,
    usedBytes,
    usedPercentage: totalBytes > 0 ? round2((usedBytes / totalBytes) * 100) : undefined,
  };
}
