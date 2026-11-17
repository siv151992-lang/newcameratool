import { describe, expect, it } from "vitest";
import { cameraInputSchema } from "../../src/services/cameraService.js";

const base = { name: "NVR", host: "10.10.6.20", username: "admin", password: "Some-Passw0rd!" };
const brandOf = (brand: string, model?: string) => (cameraInputSchema.parse({ ...base, brand, ...(model ? { model } : {}) }) as { brand: string }).brand;

describe("CP Plus: two ranges on two firmwares", () => {
  it("reads U-series models (CP-UNC, CP-UNR) as Uniview and the others as Dahua", () => {
    expect(brandOf("CP Plus", "CP-UNR-4K5324-FI")).toBe("uniview");
    expect(brandOf("cp-plus", "CP-UNC-TA21PL3-0360")).toBe("uniview");
    expect(brandOf("CP Plus", "CP-VNR-3832-V2")).toBe("dahua");
    expect(brandOf("CP Plus", "CP-VNC-T21R3")).toBe("dahua");
    expect(brandOf("CP Plus")).toBe("dahua");
    // A brand chosen by hand is kept, whatever the model.
    expect(brandOf("dahua", "CP-UNR-4K5324-FI")).toBe("dahua");
  });
});
