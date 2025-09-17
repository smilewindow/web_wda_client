# WebSocket Proxy Service

This directory contains a standalone WebSocket proxy that forwards front-end
actions to the existing HTTP backend. The proxy accepts JSON messages, maps the
`type` field to a known backend endpoint, executes the corresponding HTTP
request, and streams the result back over the socket.

## Dependencies

```
pip install -r websocket/requirements.txt
```

## Running the server

```
python websocket/server.py
```

Environment variables:

- `WS_BACKEND_BASE` (default `http://127.0.0.1:7070`): base URL of the existing
  HTTP backend.
- `WS_HOST` (default `0.0.0.0`): bind address for the WebSocket listener.
- `WS_PORT` (default `8765`): TCP port for the listener.
- `WS_REQUEST_TIMEOUT` (default `30` seconds): timeout applied to proxied HTTP
  calls.

## Message format

Requests from the front-end must be JSON objects:

```
{
  "id": "client-supplied unique token",
  "type": "device.info",
  "payload": { "optional": "parameters" }
}
```

Responses have the same `id` and `type` and contain `ok`, `status`, and either
`data` or `error` fields:

```
{
  "id": "client-supplied unique token",
  "type": "device.info",
  "ok": true,
  "status": 200,
  "data": { ... backend JSON ... }
}
```

Control helpers:

- `system.hello` with payload `{ "role": "frontend" }` registers the client
  role and returns the assigned `clientId`.
- `system.ping` returns `system.pong` to allow keep-alive checks.

## Supported message types

- `device.info` → `GET /api/device-info`
- `appium.session.create` → `POST /api/appium/create`
- `appium.settings.apply` → `POST /api/appium/settings`
- `discovery.devices.list` → `GET /api/discovery/devices`
- `appium.exec.mobile` → `POST /api/appium/exec-mobile`
- `appium.actions.execute` → `POST /api/appium/actions`

Any additional endpoints can be added by extending the `MESSAGE_ROUTES` mapping
in `server.py`.
