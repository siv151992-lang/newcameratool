import { describe, expect, it } from "vitest";
import { localTimeText, pictureFileName } from "./savePicture";

describe("pictureFileName", () => {
  it("names the file after the camera and the time, safe for any file system", () => {
    expect(pictureFileName("Lobby / Gate 2", "2026-10-27T14:05:09")).toBe("Lobby-Gate-2_2026-10-27_14-05-09.png");
    expect(pictureFileName("  ", "2026-10-27T14:05:09.500")).toBe("camera_2026-10-27_14-05-09.png");
    expect(localTimeText(new Date(2026, 0, 2, 3, 4, 5))).toBe("2026-01-02T03:04:05");
  });
});
