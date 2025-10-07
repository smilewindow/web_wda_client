import { ref, reactive, watch } from 'vue';
const noop = () => {};

export function useAppiumSession(options) {
  const {
    apSessionId: apSessionIdRef,
    getLS,
    setLS,
    removeLS,
    wsProxy,
    toast,
    describeWsError,
    streamReady,
    updateCursor,
    mjpegSrc,
    webrtcSrc,
    applyStreamMode,
    reloadCurrentStream,
    fetchDeviceInfo,
    streamToastShown,
    closeAppiumPanel,
    closeDevicePanel,
  } = options;

  const apSessionId = apSessionIdRef || ref((getLS('ap.sid', '') || '').trim());
  const safeCloseAppiumPanel = typeof closeAppiumPanel === 'function' ? closeAppiumPanel : noop;
  const safeCloseDevicePanel = typeof closeDevicePanel === 'function' ? closeDevicePanel : noop;

  const appiumSettings = reactive({
    scale: Number(getLS('ap.scale', '60')) || 60,
    fps: Number(getLS('ap.fps', '30')) || 30,
    quality: Number(getLS('ap.quality', '15')) || 15,
  });

  let appiumSettingsFetching = false;

  watch(apSessionId, (val, prevVal) => {
    const trimmed = (val || '').trim();
    if (trimmed !== val) {
      apSessionId.value = trimmed;
      return;
    }

    const prevTrimmed = (prevVal || '').trim();

    if (trimmed) {
      setLS('ap.sid', trimmed);
    } else {
      removeLS('ap.sid');
    }

    if (trimmed === prevTrimmed) {
      return;
    }

    if (!trimmed) {
      streamReady.value = false;
      updateCursor();
      mjpegSrc.value = '';
      webrtcSrc.value = '';
      applyStreamMode();
      return;
    }

    applyStreamMode();
    fetchDeviceInfo();
    refreshAppiumSettings();
  });

  function clampAppiumSetting(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, Math.round(num)));
  }

  function loadAppiumPrefs() {
    const scale = clampAppiumSetting(getLS('ap.scale', appiumSettings.scale), 30, 100, 60);
    const fps = clampAppiumSetting(getLS('ap.fps', appiumSettings.fps), 1, 60, 30);
    const quality = clampAppiumSetting(getLS('ap.quality', appiumSettings.quality), 5, 50, 15);
    if (appiumSettings.scale !== scale) appiumSettings.scale = scale;
    if (appiumSettings.fps !== fps) appiumSettings.fps = fps;
    if (appiumSettings.quality !== quality) appiumSettings.quality = quality;
  }

  async function refreshAppiumSettings() {
    if (appiumSettingsFetching) return;
    const sid = apSessionId.value.trim();
    if (!sid) return;
    const payload = { sessionId: sid };

    appiumSettingsFetching = true;
    try {
      const resp = await wsProxy.send('appium.settings.fetch', payload);
      if (!resp.ok) {
        const status = typeof resp.status === 'number' ? resp.status : 0;
        if (status === 410) {
          setSessionId('');
          streamReady.value = false;
          updateCursor();
          mjpegSrc.value = '';
          webrtcSrc.value = '';
          applyStreamMode();
        }
        const detailRaw = describeWsError(resp.error);
        const statusLabel = status > 0 ? String(status) : '未知';
        const hint = detailRaw ? `：${String(detailRaw).slice(0, 200)}` : '';
        toast(`获取 Appium 设置失败(${statusLabel})${hint}`, 'err');
        return;
      }

      const data = resp.data;
      if (!data || typeof data !== 'object') {
        return;
      }
      const payloadData = data.value && typeof data.value === 'object' ? data.value : data;
      const scaleRaw = payloadData.mjpegScalingFactor;
      const fpsRaw = payloadData.mjpegServerFramerate;
      const qualityRaw = payloadData.mjpegServerScreenshotQuality;

      const scale = scaleRaw == null ? appiumSettings.scale : clampAppiumSetting(scaleRaw, 30, 100, appiumSettings.scale);
      const fps = fpsRaw == null ? appiumSettings.fps : clampAppiumSetting(fpsRaw, 1, 60, appiumSettings.fps);
      const quality = qualityRaw == null ? appiumSettings.quality : clampAppiumSetting(qualityRaw, 5, 50, appiumSettings.quality);

      if (appiumSettings.scale !== scale) appiumSettings.scale = scale;
      if (appiumSettings.fps !== fps) appiumSettings.fps = fps;
      if (appiumSettings.quality !== quality) appiumSettings.quality = quality;
      setLS('ap.scale', String(scale));
      setLS('ap.fps', String(fps));
      setLS('ap.quality', String(quality));
    } catch (err) {
      toast(`获取 Appium 设置失败：${err}`, 'err');
    } finally {
      appiumSettingsFetching = false;
    }
  }

  async function applyAppiumSettings() {
    const sid = apSessionId.value.trim();
    if (!sid) {
      toast('请先获取或创建 Appium 会话', 'err');
      return;
    }
    const settings = {
      mjpegScalingFactor: Number(appiumSettings.scale),
      mjpegServerFramerate: Number(appiumSettings.fps),
      mjpegServerScreenshotQuality: Number(appiumSettings.quality),
    };
    setLS('ap.scale', String(settings.mjpegScalingFactor));
    setLS('ap.fps', String(settings.mjpegServerFramerate));
    setLS('ap.quality', String(settings.mjpegServerScreenshotQuality));
    try {
      const resp = await wsProxy.send('appium.settings.apply', { sessionId: sid, settings });
      if (!resp.ok) {
        const msg = describeWsError(resp.error);
        toast(`应用失败: ${String(msg || '').slice(0, 400)}`, 'err');
      } else {
        toast('已应用设置', 'ok');
        streamToastShown.value = false;
        if (hasAppiumSession()) {
          applyStreamMode();
          fetchDeviceInfo();
        }
        safeCloseAppiumPanel();
      }
    } catch (err) {
      toast(`网络错误: ${err}`, 'err');
    }
  }

  async function createSessionWithUdid(rawUdid, rawOsVersion) {
    const udid = String(rawUdid || '').trim();
    const osVersion = String(rawOsVersion || '').trim();
    if (!udid) {
      toast('该设备缺少 UDID，无法创建会话。', 'err');
      return;
    }
    try {
      const resp = await wsProxy.send('appium.session.create', {
        udid,
        osVersion: osVersion || undefined,
        wdaLocalPort: 8100,
        mjpegServerPort: 9100,
        bundleId: 'com.apple.Preferences',
        noReset: true,
      });
      const data = resp.data || {};
      if (resp.ok && data.sessionId) {
        setSessionId(data.sessionId);
        if (udid) setLS('ap.udid', udid);
        if (osVersion) setLS('ap.osVersion', osVersion);
        else removeLS('ap.osVersion');
        toast(`会话已创建: ${data.sessionId}`, 'ok');
        streamToastShown.value = false;
        reloadCurrentStream();
        fetchDeviceInfo();
        refreshAppiumSettings();
        safeCloseDevicePanel();
      } else {
        const msg = describeWsError(resp.error);
        toast(`创建失败: ${String(msg || JSON.stringify(data)).slice(0, 400)}`, 'err');
      }
    } catch (err) {
      toast(`创建失败: ${err}`, 'err');
    }
  }

  const hasAppiumSession = () => Boolean(apSessionId.value.trim());

  function setSessionId(value) {
    apSessionId.value = String(value || '').trim();
  }

  return {
    apSessionId,
    appiumSettings,
    loadAppiumPrefs,
    refreshAppiumSettings,
    applyAppiumSettings,
    createSessionWithUdid,
    hasAppiumSession,
    setSessionId,
  };
}
