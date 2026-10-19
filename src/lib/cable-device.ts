type InputDevice = {
  kind: string;
  deviceId: string;
  label: string;
};

type Endpoint = {
  name: string;
  deviceName: string;
};

const VIRTUAL_OUTPUT = /cable|vb-?audio|todesk|voicemeeter|virtual/i;

// Chromium labels an endpoint "<Name> (<Device Name>)", the same two fields svcl reports.
export function pickListenOutput(devices: InputDevice[], listen: Endpoint): InputDevice | null {
  const outputs = devices.filter(
    (device) =>
      device.kind === "audiooutput" &&
      device.deviceId &&
      device.deviceId !== "default" &&
      device.deviceId !== "communications" &&
      !VIRTUAL_OUTPUT.test(device.label),
  );
  const exact = `${listen.name} (${listen.deviceName})`;
  return (
    outputs.find((device) => device.label === exact) ||
    outputs.find((device) => device.label.startsWith(listen.name) && device.label.includes(listen.deviceName)) ||
    null
  );
}

export function pickCableOutput(devices: InputDevice[]): InputDevice | null {
  const inputs = devices.filter((device) => device.kind === "audioinput" && device.deviceId);
  const output = inputs.find((device) => /cable\s*output/i.test(device.label));
  if (output) return output;
  return (
    inputs.find((device) => /virtual\s*cable/i.test(device.label) && !/voicemeeter|cable\s*input/i.test(device.label)) ||
    null
  );
}
