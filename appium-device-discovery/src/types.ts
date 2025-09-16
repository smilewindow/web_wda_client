export type DeviceBasic = {
  udid: string;
  name: string | null;
  osVersion: string | null;
  model: string | null;
  serialNumber: string | null;
};

export type DeviceEnriched = DeviceBasic & {
  connection?: string | null;
  raw?: Record<string, unknown>;
};

export type Health = {
  ok: boolean;
  xcrunFound: boolean;
  devicectlAvailable: boolean;
};
