<template>
  <div id="device-panel" v-show="visible">
    <div class="head">
      <h4>可用设备</h4>
      <button class="btn" id="device-close" @click="$emit('close')">关闭</button>
    </div>
    <div class="body" ref="bodyRef">
      <div class="empty" v-if="!devices.length">{{ emptyText }}</div>
      <div class="device-card" v-for="device in devices" :key="device.udid || device.name">
        <h5>{{ device.name || '未知设备' }} ({{ device.udid || '无 UDID' }})</h5>
        <div class="kv">系统: {{ device.osVersion || '-' }} | 型号: {{ device.model || '-' }} | 连接: {{ device.connection || '未知' }}</div>
        <div class="device-actions">
          <button class="btn" @click="$emit('create-session', device)">创建会话</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue';

const props = defineProps({
  visible: { type: Boolean, default: false },
  devices: { type: Array, default: () => [] },
  emptyText: { type: String, default: '正在获取设备列表…' },
});

const emit = defineEmits(['close', 'create-session']);

const bodyRef = ref(null);

watch(() => props.visible, (visible) => {
  if (visible) {
    try {
      if (bodyRef.value) bodyRef.value.scrollTop = 0;
    } catch (_err) {}
  }
});
</script>

<style scoped>
#device-panel {
  position: absolute;
  right: 16px;
  bottom: 16px;
  width: 320px;
  max-height: 420px;
  padding: 16px;
  background: rgba(15, 15, 18, 0.96);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.32);
  display: flex;
  flex-direction: column;
  gap: 12px;
  color: var(--fg);
  z-index: 150;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.body {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.empty {
  text-align: center;
  color: var(--muted);
  padding: 24px 0;
}

.device-card {
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.02);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.kv {
  color: var(--muted);
  font-size: 13px;
}

.device-actions {
  display: flex;
  justify-content: flex-end;
}
</style>
