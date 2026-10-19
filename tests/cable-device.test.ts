import { describe, expect, it } from "vitest";
import { pickCableOutput, pickListenOutput } from "../src/lib/cable-device";

describe("pickListenOutput", () => {
  const outputs = [
    { kind: "audiooutput", deviceId: "default", label: "默认 - 耳机 (Senary Audio)" },
    { kind: "audiooutput", deviceId: "todesk", label: "扬声器 (ToDesk Virtual Audio)" },
    { kind: "audiooutput", deviceId: "speakers", label: "扬声器 (Senary Audio)" },
    { kind: "audiooutput", deviceId: "phones", label: "耳机 (Senary Audio)" },
    { kind: "audiooutput", deviceId: "cable", label: "CABLE Input (VB-Audio Virtual Cable)" },
  ];

  it("matches the endpoint svcl picked, not a same-named virtual one", () => {
    expect(pickListenOutput(outputs, { name: "扬声器", deviceName: "Senary Audio" })?.deviceId).toBe("speakers");
    expect(pickListenOutput(outputs, { name: "耳机", deviceName: "Senary Audio" })?.deviceId).toBe("phones");
  });

  it("refuses to guess when the endpoint is not in the list", () => {
    expect(pickListenOutput(outputs, { name: "AirPods", deviceName: "Bluetooth" })).toBeNull();
  });
});

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
