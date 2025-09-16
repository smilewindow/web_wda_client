import { utilities } from "appium-ios-device";
import type { DeviceBasic, DeviceEnriched } from "./types";
import { listDevicesByDevicectl, isXcrunAvailable } from "./devicectl";
import { logger } from "./logger";

export async function getBasicDevices(): Promise<DeviceBasic[]> {
  const udids: string[] = await utilities.getConnectedDevices();
  const results: DeviceBasic[] = await Promise.all(
    udids.map(async (udid) => {
      const [name, osVersion, info] = await Promise.all([
        utilities.getDeviceName(udid).catch(() => null),
        utilities.getOSVersion(udid).catch(() => null),
        utilities.getDeviceInfo(udid).catch(() => null)
      ]);

      const model = (info as any)?.ProductType ?? null;
      const serialNumber = (info as any)?.SerialNumber ?? null;

      return {
        udid,
        name: name ?? (info as any)?.DeviceName ?? null,
        osVersion: osVersion ?? (info as any)?.ProductVersion ?? null,
        model,
        serialNumber
      };
    })
  );
  return results;
}

export async function getDevicesEnriched(): Promise<DeviceEnriched[]> {
  const basics = await getBasicDevices();
  const enrichEnabled = (process.env.ENABLE_DEVICETCL_ENRICH || "false").toLowerCase() === "true";
  let dmap = new Map<string, any>();

  if (enrichEnabled) {
    const xcrunOk = await isXcrunAvailable();
    if (!xcrunOk) {
      logger.warn("ENABLE_DEVICETCL_ENRICH=true 但 devicectl 不可用，忽略增强。");
    } else {
      try {
        dmap = await listDevicesByDevicectl();
      } catch (e) {
        logger.warn({ err: e }, "devicectl 拉取失败，忽略增强。");
      }
    }
  }

  return basics.map((b) => {
    const extra = dmap.get(b.udid);
    const connection = extra?.connection ?? null;
    return { ...b, connection };
  });
}

export async function getDeviceDetail(udid: string): Promise<DeviceEnriched | null> {
  const info = await utilities.getDeviceInfo(udid).catch(() => null);
  if (!info) return null;

  const name = await utilities.getDeviceName(udid).catch(() => null);
  const osVersion = await utilities.getOSVersion(udid).catch(() => null);

  const enriched: DeviceEnriched = {
    udid,
    name: name ?? (info as any)?.DeviceName ?? null,
    osVersion: osVersion ?? (info as any)?.ProductVersion ?? null,
    model: (info as any)?.ProductType ?? null,
    serialNumber: (info as any)?.SerialNumber ?? null,
    raw: info as any
  };

  const enrichEnabled = (process.env.ENABLE_DEVICETCL_ENRICH || "false").toLowerCase() === "true";
  if (enrichEnabled) {
    try {
      const dmap = await listDevicesByDevicectl();
      enriched.connection = dmap.get(udid)?.connection ?? null;
    } catch {
      // ignore errors when enriching detail
    }
  }

  return enriched;
}
