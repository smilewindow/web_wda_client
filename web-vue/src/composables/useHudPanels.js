import { ref, watch } from 'vue';

/**
 * 管理 HUD 面板显隐及互斥逻辑。
 * 将原本散落在 App.vue 内的面板状态与副作用集中，便于维护。
 */
export function useHudPanels(options = {}) {
  const {
    onAppiumOpen,
    onDeviceOpen,
    onGestureOpen,
    onZoomOpen,
    onWsConfigOpen,
    onPullConfigOpen,
  } = options;

  const showAppiumPanel = ref(false);
  const showDevicePanel = ref(false);
  const showGesturePanel = ref(false);
  const showZoomPanel = ref(false);
  const showWsConfigPanel = ref(false);
  const showPullConfigPanel = ref(false);

  const closeTransientPanels = () => {
    showZoomPanel.value = false;
    showWsConfigPanel.value = false;
    showPullConfigPanel.value = false;
  };

  watch(showAppiumPanel, (visible) => {
    if (visible && typeof onAppiumOpen === 'function') onAppiumOpen();
  });

  watch(showDevicePanel, (visible) => {
    if (visible && typeof onDeviceOpen === 'function') onDeviceOpen();
  });

  watch(showGesturePanel, (visible) => {
    if (visible && typeof onGestureOpen === 'function') onGestureOpen();
  });

  watch(showZoomPanel, (visible) => {
    if (visible && typeof onZoomOpen === 'function') onZoomOpen();
  });

  watch(showWsConfigPanel, (visible) => {
    if (visible && typeof onWsConfigOpen === 'function') onWsConfigOpen();
  });

  watch(showPullConfigPanel, (visible) => {
    if (visible && typeof onPullConfigOpen === 'function') onPullConfigOpen();
  });

  const openAppiumPanel = () => { showAppiumPanel.value = true; };
  const closeAppiumPanel = () => { showAppiumPanel.value = false; };
  const toggleAppiumPanel = () => { showAppiumPanel.value = !showAppiumPanel.value; };
  const toggleDevicePanel = () => { showDevicePanel.value = !showDevicePanel.value; };
  const toggleGesturePanel = () => { showGesturePanel.value = !showGesturePanel.value; };

  const toggleZoomPanel = () => {
    const next = !showZoomPanel.value;
    closeTransientPanels();
    showZoomPanel.value = next;
  };

  const toggleWsConfigPanel = () => {
    const next = !showWsConfigPanel.value;
    closeTransientPanels();
    showWsConfigPanel.value = next;
  };

  const togglePullConfigPanel = () => {
    const next = !showPullConfigPanel.value;
    closeTransientPanels();
    showPullConfigPanel.value = next;
  };

  return {
    showAppiumPanel,
    showDevicePanel,
    showGesturePanel,
    showZoomPanel,
    showWsConfigPanel,
    showPullConfigPanel,
    openAppiumPanel,
    closeAppiumPanel,
    toggleAppiumPanel,
    toggleDevicePanel,
    toggleGesturePanel,
    toggleZoomPanel,
    toggleWsConfigPanel,
    togglePullConfigPanel,
    closeTransientPanels,
  };
}
