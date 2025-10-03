<template>
  <div id="hud-stream" v-show="visible">
    <label for="stream-mode" class="muted">流源</label>
    <select
      id="stream-mode"
      :value="mode"
      @change="onChange"
      style="padding:4px 6px;border:1px solid var(--line);border-radius:8px;background:#0f0f12;color:var(--fg)"
    >
      <option value="mjpeg">MJPEG（后端 /stream）</option>
      <option value="webrtc">WebRTC（自建推流）</option>
    </select>
    <button class="btn" id="stream-apply" @click="$emit('apply')">应用流源</button>
  </div>
</template>

<script setup>
const props = defineProps({
  visible: { type: Boolean, default: false },
  mode: { type: String, default: 'mjpeg' },
});

const emit = defineEmits(['update:mode', 'apply']);

function onChange(event) {
  emit('update:mode', event.target.value === 'webrtc' ? 'webrtc' : 'mjpeg');
}
</script>
