/**
 * Alert sounds, made in the browser (no sound files): a critical alert beeps three times high, a
 * warning twice lower. Browsers only play sound once the page has been clicked or a key pressed;
 * until then playAlert reports that it was blocked.
 */

export type AlertSoundSetting = "off" | "critical" | "all";
const KEY = "cctv-alert-sound";

export function readAlertSoundSetting(): AlertSoundSetting {
  try {
    const v = localStorage.getItem(KEY);
    return v === "off" || v === "critical" || v === "all" ? v : "all";
  } catch {
    return "all";
  }
}
export function saveAlertSoundSetting(v: AlertSoundSetting) {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    // Private window or storage blocked: the setting lasts until the page is closed.
  }
}

let ctx: AudioContext | undefined;
const audio = () => {
  if (!ctx && typeof window !== "undefined" && "AudioContext" in window) ctx = new AudioContext();
  return ctx;
};

/** Lets sound play: call from a click or key press (browsers allow audio only after one). */
export function unlockAlertSound() {
  void audio()?.resume().catch(() => undefined);
}

/** From a click: lets sound play, then plays the sample (resuming is not immediate). */
export function sampleAlertSound(severity: "critical" | "warning") {
  void audio()?.resume().then(() => playAlert(severity), () => undefined);
}

/** Plays the alert's sound; false when the browser has not allowed sound yet. */
export function playAlert(severity: "critical" | "warning" | "info"): boolean {
  const c = audio();
  if (!c) return false;
  // Not allowed yet (no click or key press on the page so far): ask again for next time.
  if (c.state !== "running") {
    void c.resume().catch(() => undefined);
    return false;
  }
  const [freq, beeps] = severity === "critical" ? [880, 3] : [660, 2];
  const start = c.currentTime + 0.02;
  for (let i = 0; i < beeps; i++) {
    const t = start + i * 0.28;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.22);
  }
  return true;
}

/**
 * The alerts that are new since the last look: their ids not seen before. The first look only
 * learns what is already open (no sound for alerts that were there when the page opened).
 */
export function newAlerts<T extends { id: number | string }>(seen: Set<string> | null, alerts: T[]): { seen: Set<string>; fresh: T[] } {
  const ids = new Set(alerts.map((a) => String(a.id)));
  if (!seen) return { seen: ids, fresh: [] };
  return { seen: ids, fresh: alerts.filter((a) => !seen.has(String(a.id))) };
}
