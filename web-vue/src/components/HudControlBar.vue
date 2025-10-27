<template>
  <div class="hud-wrapper">
    <div id="hud">
      <span class="pill hud-size-pill" id="hud-size">{{ hudSizeText }}</span>
      <button class="btn" id="btn-appium" @click="$emit('toggle-appium')">Appium 设置</button>
      <button class="btn" id="btn-devices" @click="$emit('toggle-device')">设备列表</button>
    </div>
    <div id="hud-controls">
      <div class="control-row">
        <button class="btn" id="btn-zoom-panel" @click="$emit('toggle-zoom')">画面缩放</button>
        <template v-if="isDev">
          <button class="btn" id="btn-stream-panel" @click="$emit('toggle-stream')">流源切换</button>
          <button class="btn" id="btn-ws-config" @click="$emit('toggle-ws')">WebSocket 配置</button>
          <button class="btn" id="btn-pull-config" @click="$emit('toggle-pull')">拉流配置</button>
        </template>
      </div>
      <div class="preset-row" ref="dropdownRef">
        <button class="btn preset-trigger" id="btn-preset-panel" type="button" @click.stop="togglePresetMenu">
          推流分辨率：{{ preset }}
        </button>
        <div
          v-if="presetMenuVisible"
          class="preset-menu"
        >
          <span class="preset-label">选择推流分辨率</span>
          <button
            v-for="option in presetOptions"
            :key="option"
            class="menu-item"
            :class="{ active: option === preset }"
            type="button"
            @click.stop="selectPreset(option)"
          >{{ option }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';

const props = defineProps({
  hudSizeText: { type: String, default: '' },
  isDev: { type: Boolean, default: false },
  preset: { type: String, default: '720p' },
  presetOptions: { type: Array, default: () => [] },
});

const emit = defineEmits([
  'toggle-appium',
  'toggle-device',
  'toggle-zoom',
  'toggle-stream',
  'toggle-ws',
  'toggle-pull',
  'change-preset',
]);

const presetMenuVisible = ref(false);
const dropdownRef = ref(null);

function togglePresetMenu() {
  presetMenuVisible.value = !presetMenuVisible.value;
}

function selectPreset(option) {
  presetMenuVisible.value = false;
  emit('change-preset', option);
}

function handleGlobalClick(event) {
  const root = dropdownRef.value;
  if (!root) {
    presetMenuVisible.value = false;
    return;
  }
  if (root.contains(event.target)) return;
  presetMenuVisible.value = false;
}

onMounted(() => {
  document.addEventListener('click', handleGlobalClick);
});

onBeforeUnmount(() => {
  document.removeEventListener('click', handleGlobalClick);
});
</script>

<style scoped>
.hud-wrapper {
  position: relative;
}

.hud-size-pill {
  display: inline-flex;
  flex-direction: column;
  white-space: pre-wrap;
  line-height: 1.2;
  padding: 4px 8px;
  border-radius: 999px;
  text-align: center;
  align-items: center;
  justify-content: center;
}

#hud-controls {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}

.control-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  width: 100%;
}

.preset-row {
  position: relative;
  width: 100%;
  display: flex;
  align-items: center;
}

.preset-trigger {
  text-align: left;
}

.preset-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px;
  min-width: 160px;
  border-radius: 10px;
  background: rgba(22, 22, 26, 0.95);
  border: 1px solid var(--line);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.36);
  z-index: 10;
}

.preset-label {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 2px;
}

.menu-item {
  border: none;
  background: rgba(255, 255, 255, 0.05);
  color: var(--fg);
  padding: 6px 10px;
  border-radius: 6px;
  text-align: left;
  cursor: pointer;
  transition: background 0.2s ease;
}

.menu-item:hover {
  background: rgba(255, 255, 255, 0.1);
}

.menu-item.active {
  background: var(--accent);
  color: #000;
}
</style>
