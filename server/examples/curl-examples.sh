#!/usr/bin/env bash
set -euo pipefail

# Base URL for backend
BASE="${BASE:-http://127.0.0.1:7000}"
hdr=(-H 'Content-Type: application/json')

echo "[PING]" && curl -sS "$BASE/api/ping" | jq . || true
echo

echo "[DEVICE INFO]" && curl -sS "$BASE/api/device-info" | jq . || true
echo

echo "[TAP @ (100,200)]" && curl -sS -X POST "$BASE/api/tap" "${hdr[@]}" \
  -d '{"x":100,"y":200}' | jq . || true
echo

echo "[PRESS home]" && curl -sS -X POST "$BASE/api/pressButton" "${hdr[@]}" \
  -d '{"name":"home"}' | jq . || true
echo

echo "[DRAG  (10,10) -> (300,400)]" && curl -sS -X POST "$BASE/api/drag" "${hdr[@]}" \
  -d '{"from":{"x":10,"y":10},"to":{"x":300,"y":400},"duration":0.12}' | jq . || true
echo

echo "[DRAG-PUMP points]" && curl -sS -X POST "$BASE/api/drag-pump" "${hdr[@]}" \
  -d '{"points":[{"x":10,"y":10},{"x":100,"y":100},{"x":200,"y":300}],"segDuration":0.08}' | jq . || true
echo

echo "[MJPEG START]" && curl -sS -X POST "$BASE/api/mjpeg/start" | jq . || true
echo

echo "[STREAM HEADERS]" && curl -I "$BASE/stream" || true

