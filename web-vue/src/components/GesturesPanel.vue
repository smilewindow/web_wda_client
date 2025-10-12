<template>
  <div id="gest-panel" v-show="visible">
    <header>
      <span class="muted">手势日志</span>
      <button id="gest-close" class="btn" @click="$emit('close')">关闭</button>
    </header>
    <div class="body">
      <div class="g-section">
        <div class="g-sec-head">
          <h3>事件日志</h3>
          <button id="gest-clear" class="btn" @click="$emit('clear')">清空</button>
        </div>
        <div id="gest-log" ref="logEl">
          <div v-for="(line, idx) in gestureLog" :key="idx">{{ line }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watchEffect, watch, nextTick } from 'vue';

const props = defineProps({
  visible: { type: Boolean, default: false },
  gestureLog: { type: Array, default: () => [] },
  logRef: { type: Object, default: null },
});

defineEmits(['close', 'clear']);

const logEl = ref(null);

watchEffect(() => {
  if (props.logRef && typeof props.logRef === 'object') {
    props.logRef.value = logEl.value;
  }
});

watch(() => props.visible, (visible) => {
  if (!visible) return;
  nextTick(() => {
    const el = logEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
});

watch(() => props.gestureLog.length, () => {
  if (!props.visible) return;
  nextTick(() => {
    const el = logEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
});
</script>
