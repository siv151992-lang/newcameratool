/** Zoho brand colors. */
export const ZOHO = { red: "#E42527", green: "#089949", blue: "#226DB4", yellow: "#F9B21D" };

/** The four Zoho colors as a thin band. */
export function ZohoBand({ className = "" }: { className?: string }) {
  return (
    <div aria-hidden className={`flex ${className}`}>
      {[ZOHO.red, ZOHO.green, ZOHO.blue, ZOHO.yellow].map((c) => (
        <span key={c} className="flex-1" style={{ background: c }} />
      ))}
    </div>
  );
}
