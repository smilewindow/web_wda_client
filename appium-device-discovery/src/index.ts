import express from "express";
import cors from "cors";
import { logger } from "./logger";
import { getDevicesEnriched, getDeviceDetail } from "./deviceService";
import type { Health } from "./types";
import { isXcrunAvailable } from "./devicectl";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const app = express();
const PORT = Number(process.env.PORT || 3030);
const ENABLE_CORS = (process.env.ENABLE_CORS || "true").toLowerCase() === "true";

if (ENABLE_CORS) app.use(cors());
app.use(express.json());

app.get("/health", async (_req, res) => {
  const xcrunFound = await isToolAvailable("xcrun");
  const devicectlAvailable = xcrunFound && (await isXcrunAvailable());
  const health: Health = { ok: true, xcrunFound, devicectlAvailable };
  res.json(health);
});

app.get("/devices", async (_req, res) => {
  try {
    const devices = await getDevicesEnriched();
    res.json({ devices });
  } catch (err: any) {
    logger.error({ err }, "List devices failed");
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.get("/devices/:udid", async (req, res) => {
  try {
    const { udid } = req.params;
    const detail = await getDeviceDetail(udid);
    if (!detail) return res.status(404).json({ error: "Device not found or not paired/trusted" });
    res.json(detail);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.listen(PORT, () => {
  logger.info(`Device discovery service listening on http://localhost:${PORT}`);
});

async function isToolAvailable(bin: string): Promise<boolean> {
  try {
    await execFileAsync("which", [bin]);
    return true;
  } catch {
    return false;
  }
}
