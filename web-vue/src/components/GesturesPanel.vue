<template>
  <div id="gest-panel" v-show="visible">
    <header>
      <div class="row">
        <label for="gest-w3c-tune" class="muted">滚动调优（W3C）</label>
        <select
          id="gest-w3c-tune"
          :value="w3cTune"
          @change="onTuneChange"
          style="padding:4px 6px;border:1px solid var(--line);border-radius:8px;background:#0f0f12;color:var(--fg)"
        >
          <option value="fast">fast（原始极速版）</option>
        </select>
      </div>
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
  w3cTune: { type: String, default: 'fast' },
  gestureLog: { type: Array, default: () => [] },
  logRef: { type: Object, default: null },
});

const emit = defineEmits(['update:w3cTune', 'close', 'clear']);

const logEl = ref(null);

watchEffect(() => {
  if (props.logRef && typeof props.logRef === 'object') {
    props.logRef.value = logEl.value;
  }
});

function onTuneChange(event) {
  emit('update:w3cTune', event.target.value === 'fast' ? 'fast' : 'fast');
}

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
