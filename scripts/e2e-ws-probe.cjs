// E2E probe: /m/api/events.host WebSocket — authorized handshake + first frame vs raw 403.
const WebSocket = require('ws')

const port = process.argv[2] ?? '3199'
const token = process.argv[3] ?? 'your-token'

function probe(url, headers, label) {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers })
    const timer = setTimeout(() => { console.log(`${label}: timeout`); socket.terminate(); resolve() }, 8000)
    socket.on('open', () => console.log(`${label}: handshake OPEN (downlink live)`))
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString())
      console.log(`${label}: frame method=${frame.method ?? '(none)'}`)
      clearTimeout(timer); socket.close(); resolve()
    })
    socket.on('unexpected-response', (_req, res) => {
      console.log(`${label}: refused HTTP ${res.statusCode}`)
      clearTimeout(timer); resolve()
    })
    socket.on('error', (error) => {
      if (timer._destroyed) return
      console.log(`${label}: error ${error.message}`)
    })
  })
}

;(async () => {
  await probe(`ws://127.0.0.1:${port}/m/api/events.host`, {}, 'no-token   ')
  await probe(`ws://127.0.0.1:${port}/m/api/events.host`, { authorization: `Bearer ${token}` }, 'authorized')
})()
