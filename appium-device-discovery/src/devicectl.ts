import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function isXcrunAvailable(): Promise<boolean> {
  try {
    await execFileAsync("xcrun", ["-f", "devicectl"]);
    return true;
  } catch {
    return false;
  }
}

export type DevicectlItem = {
  identifier?: string;
  name?: string;
  osVersion?: string;
  platform?: string;
  connection?: string;
  deviceTypeIdentifier?: string;
  state?: string;
};

export async function listDevicesByDevicectl(): Promise<Map<string, DevicectlItem>> {
  const { stdout } = await execFileAsync("xcrun", [
    "devicectl", "list", "devices", "--quiet", "--json-output", "-"
  ]);
  const data = JSON.parse(stdout);
  const arr: DevicectlItem[] = data?.result?.devices || data?.devices || [];
  const map = new Map<string, DevicectlItem>();
  for (const d of arr) {
    const udid = (d as any).identifier || (d as any).Identifier;
    if (!udid) continue;
    map.set(udid, {
      identifier: udid,
      name: (d as any).name || (d as any).Name,
      osVersion: (d as any).osVersion || (d as any).OSVersion,
      platform: (d as any).platform || (d as any).Platform,
      connection: (d as any).connection || (d as any).Connection,
      deviceTypeIdentifier: (d as any).deviceTypeIdentifier || (d as any).Model,
      state: (d as any).state || (d as any).State
    });
  }
  return map;
}
