<template>
  <div id="hud-pull-config" v-show="visible">
    <div class="pull-row">
      <label for="pull-webrtc-host" class="muted">WebRTC 地址</label>
      <input
        type="text"
        id="pull-webrtc-host"
        :value="value"
        placeholder="host:port 或 http://地址（留空默认 8889/iphone）"
        @input="onInput"
      />
    </div>
    <button class="btn" id="pull-apply" @click="$emit('apply')">应用</button>
  </div>
</template>

<script setup>
const props = defineProps({
  visible: { type: Boolean, default: false },
  value: { type: String, default: '' },
});

const emit = defineEmits(['update:value', 'apply']);

function onInput(event) {
  emit('update:value', event.target.value);
}
</script>
