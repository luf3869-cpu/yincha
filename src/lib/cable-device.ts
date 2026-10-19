type InputDevice = {
  kind: string;
  deviceId: string;
  label: string;
};

export function pickCableOutput(devices: InputDevice[]): InputDevice | null {
  const inputs = devices.filter((device) => device.kind === "audioinput" && device.deviceId);
  const output = inputs.find((device) => /cable\s*output/i.test(device.label));
  if (output) return output;
  return (
    inputs.find((device) => /virtual\s*cable/i.test(device.label) && !/voicemeeter|cable\s*input/i.test(device.label)) ||
    null
  );
}
