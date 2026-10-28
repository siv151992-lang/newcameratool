import { describe, expect, it } from "vitest";
import { describeStart } from "./Recordings";

describe("describeStart", () => {
  const browser = { prepared: 90, opened: 150, firstVideo: 300, playing: 3000 };

  it("names the camera's I-frame interval when the wait for a picture is long", () => {
    const line = describeStart(browser, { connect: 0, describe: 110, play: 40, firstVideo: 120, total: 270, firstPicture: 2200, pictureInterval: 4000 });
    expect(line).toBe(
      "Started in 3.0 s: server 0.09 s · camera 0.27 s (connect 0.00 s, describe 0.11 s, play 0.04 s, first video 0.12 s) · picture 2.7 s after the video arrived. " +
        "The camera's first full picture (I-frame) came 2.2 s after its video began, and it sends one every 4.0 s: set the camera's I-frame interval to its frame rate (one per second) and turn off H.264+ / Smart Codec to start faster",
    );
  });

  it("gives no advice when the camera started on a full picture, whatever its interval", () => {
    const line = describeStart({ prepared: 30, opened: 60, firstVideo: 150, playing: 930 }, { total: 200, firstPicture: 0, pictureInterval: 6600 });
    expect(line).toBe("Started in 0.93 s: server 0.03 s · camera 0.20 s · picture 0.78 s after the video arrived. The camera's first full picture (I-frame) came 0.00 s after its video began, and it sends one every 6.6 s");
  });

  it("only reports the timing when the start is quick", () => {
    const line = describeStart({ prepared: 40, opened: 90, firstVideo: 200, playing: 700 }, { total: 150, firstPicture: 300, pictureInterval: 1000 });
    expect(line).toBe("Started in 0.70 s: server 0.04 s · camera 0.15 s · picture 0.50 s after the video arrived. The camera's first full picture (I-frame) came 0.30 s after its video began, and it sends one every 1.0 s");
  });
});
