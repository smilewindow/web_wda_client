<template>
  <div id="toolbar">
    <button class="btn" id="btn-home" @click="$emit('press', 'home')">Home</button>
    <button class="btn" id="btn-lock" @click="$emit('press', 'lock')">Lock</button>
    <button class="btn" id="btn-vol-up" @click="$emit('press', 'volUp')">Vol +</button>
    <button class="btn" id="btn-vol-down" @click="$emit('press', 'volDown')">Vol −</button>
    <button class="btn" id="btn-reload" @click="$emit('reload')">重载</button>
  </div>
</template>

<script setup>
defineEmits(['press', 'reload']);
</script>
