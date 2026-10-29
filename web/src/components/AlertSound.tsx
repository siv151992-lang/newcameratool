import { useQuery } from "@tanstack/react-query";
import { Volume1, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { Alert, Page } from "../api/types";
import { useAuth } from "../hooks/auth";
import { type AlertSoundSetting, newAlerts, playAlert, readAlertSoundSetting, sampleAlertSound, saveAlertSoundSetting, unlockAlertSound } from "../lib/alertSound";
import { useToast } from "./toast";
import { Button } from "./ui";

const NEXT: Record<AlertSoundSetting, AlertSoundSetting> = { all: "critical", critical: "off", off: "all" };
const LABEL: Record<AlertSoundSetting, string> = { all: "Sound for all new alerts", critical: "Sound for new critical alerts only", off: "Alert sound off" };

/**
 * Plays a sound when a new alert opens, while the dashboard is open in this browser (checked every
 * 15 seconds). The header button cycles all alerts → critical only → off; the choice is kept in
 * this browser. Alerts already open when the page opened make no sound.
 */
export function AlertSound() {
  const { user, can } = useAuth();
  const toast = useToast();
  const [setting, setSetting] = useState<AlertSoundSetting>(readAlertSoundSetting);
  const seen = useRef<Set<string> | null>(null);
  const warnedBlocked = useRef(false);
  const org = user?.organizationId ?? null;

  // Browsers allow sound only after the page has been clicked or a key pressed.
  useEffect(() => {
    const unlock = () => unlockAlertSound();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  // Another organization's alerts, or those opened while the sound was off, are not new: learn them afresh.
  useEffect(() => {
    seen.current = null;
  }, [org, setting]);
  const lastLook = useRef(0);

  const enabled = setting !== "off" && can("alerts:read") && org !== null;
  const active = useQuery({
    queryKey: ["alerts", "sound", org],
    queryFn: () => api<Page<Alert>>("/alerts?status=active&pageSize=200"),
    enabled,
    refetchInterval: 15_000,
    refetchIntervalInBackground: true,
  });

  useEffect(() => {
    if (!active.data) return;
    const { seen: now, fresh } = newAlerts(seen.current, active.data.items);
    seen.current = now;
    // More open alerts than one page: one that only moved into the page is not new.
    const since = lastLook.current - 60_000;
    lastLook.current = Date.now();
    const partial = active.data.total > active.data.items.length;
    const sounding = fresh
      .filter((a) => !partial || Date.parse(a.firstDetectedAt) >= since)
      .filter((a) => (setting === "all" ? a.severity !== "info" : a.severity === "critical"));
    if (!sounding.length) return;
    const critical = sounding.some((a) => a.severity === "critical");
    const played = playAlert(critical ? "critical" : "warning");
    const first = sounding[0]!;
    toast("error", `New alert: ${first.title} (${first.cameraName})${sounding.length > 1 ? ` and ${sounding.length - 1} more` : ""}`);
    if (!played && !warnedBlocked.current) {
      warnedBlocked.current = true;
      toast("error", "Click anywhere on the page once so the browser lets the dashboard play alert sounds.");
    }
  }, [active.data, setting, toast]);

  if (!can("alerts:read")) return null;
  const Icon = setting === "off" ? VolumeX : setting === "critical" ? Volume1 : Volume2;
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={`${LABEL[setting]}. Change`}
      title={`${LABEL[setting]} (click to change)`}
      icon={<Icon className="h-4 w-4" />}
      onClick={() => {
        const next = NEXT[setting];
        setSetting(next);
        saveAlertSoundSetting(next);
        // A short sample, so the choice is heard (and the browser allows sound from now on).
        if (next !== "off") sampleAlertSound(next === "critical" ? "critical" : "warning");
        toast("success", LABEL[next]);
      }}
    />
  );
}
