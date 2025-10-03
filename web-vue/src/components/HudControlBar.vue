<template>
  <div class="hud-wrapper">
    <div id="hud">
      <span class="pill hud-size-pill" id="hud-size">{{ hudSizeText }}</span>
      <button class="btn" id="btn-appium" @click="$emit('toggle-appium')">Appium 设置</button>
      <button class="btn" id="btn-devices" @click="$emit('toggle-device')">设备列表</button>
    </div>
    <div id="hud-controls">
      <button class="btn" id="btn-zoom-panel" @click="$emit('toggle-zoom')">画面缩放</button>
      <template v-if="isDev">
        <button class="btn" id="btn-stream-panel" @click="$emit('toggle-stream')">流源切换</button>
        <button class="btn" id="btn-ws-config" @click="$emit('toggle-ws')">WebSocket 配置</button>
        <button class="btn" id="btn-pull-config" @click="$emit('toggle-pull')">拉流配置</button>
      </template>
    </div>
  </div>
</template>

<script setup>
const props = defineProps({
  hudSizeText: { type: String, default: '' },
  isDev: { type: Boolean, default: false },
});

const emit = defineEmits([
  'toggle-appium',
  'toggle-device',
  'toggle-zoom',
  'toggle-stream',
  'toggle-ws',
  'toggle-pull',
]);
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
</style>
