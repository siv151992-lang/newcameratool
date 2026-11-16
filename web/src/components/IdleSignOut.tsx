import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/auth";
import { Button, Dialog } from "./ui";

const KEY = "cctv-last-activity";
const WARN_SECONDS = 60;

/** The last mouse, keyboard or touch use in any tab of this browser. */
function readShared(): number {
  try {
    return Number(localStorage.getItem(KEY)) || 0;
  } catch {
    return 0;
  }
}
function writeShared(ms: number) {
  try {
    localStorage.setItem(KEY, String(ms));
  } catch {
    // private mode: this tab alone counts
  }
}

/**
 * Signs out after `minutes` without mouse, keyboard or touch use, with a minute's warning. Requests
 * the page makes on its own (refreshing the dashboard) do not count. The Live page is left open:
 * control-room screens show it all day. Activity in any tab of the browser counts for all of them.
 */
export function IdleSignOut({ minutes }: { minutes: number }) {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const last = useRef(Date.now());
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const exempt = pathname.startsWith("/live");

  useEffect(() => {
    if (!minutes) return;
    const touch = () => {
      const now = Date.now();
      if (now - last.current > 5_000) writeShared(now);
      last.current = now;
    };
    touch();
    const events = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "scroll"] as const;
    for (const e of events) window.addEventListener(e, touch, { passive: true });
    const timer = window.setInterval(() => {
      if (exempt) {
        touch();
        setSecondsLeft(null);
        return;
      }
      const since = Date.now() - Math.max(last.current, readShared());
      const left = Math.ceil((minutes * 60_000 - since) / 1000);
      if (left <= 0) {
        window.clearInterval(timer);
        void logout().finally(() => navigate("/login?reason=idle", { replace: true }));
      } else setSecondsLeft(left <= WARN_SECONDS ? left : null);
    }, 1000);
    return () => {
      for (const e of events) window.removeEventListener(e, touch);
      window.clearInterval(timer);
    };
  }, [minutes, exempt, logout, navigate]);

  return (
    <Dialog
      open={secondsLeft !== null}
      onClose={() => { last.current = Date.now(); writeShared(last.current); setSecondsLeft(null); }}
      title="Still there?"
      footer={
        <>
          <Button onClick={() => void logout().finally(() => navigate("/login", { replace: true }))}>Sign out now</Button>
          <Button variant="primary" onClick={() => { last.current = Date.now(); writeShared(last.current); setSecondsLeft(null); }}>Stay signed in</Button>
        </>
      }
    >
      <p>For security you will be signed out in <strong className="tabular">{secondsLeft}</strong> seconds, after {minutes} minutes without use.</p>
    </Dialog>
  );
}
