import { describe, expect, it } from "vitest";
import { pickCableOutput } from "../src/lib/cable-device";

describe("pickCableOutput", () => {
  it("chooses CABLE Output and skips other VB-Audio devices", () => {
    const devices = [
      { kind: "audioinput", deviceId: "vm", label: "Voicemeeter Out (VB-Audio Voicemeeter)" },
      { kind: "audioinput", deviceId: "cable", label: "CABLE Output (VB-Audio Virtual Cable)" },
      { kind: "audiooutput", deviceId: "in", label: "CABLE Input (VB-Audio Virtual Cable)" },
    ];
    expect(pickCableOutput(devices)?.deviceId).toBe("cable");
  });

  it("does not fall back to a VB-Audio device that is not the virtual cable", () => {
    const devices = [{ kind: "audioinput", deviceId: "vm", label: "Voicemeeter Out (VB-Audio Voicemeeter)" }];
    expect(pickCableOutput(devices)).toBeNull();
  });
});
