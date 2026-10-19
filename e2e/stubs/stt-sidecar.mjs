// Minimal WebSocket stand-in for the sherpa-onnx online-websocket-server,
// speaking its protocol: binary float32 samples in, text JSON results out;
// text "Done" marks end of input, the sentinel text "Done!" ends the stream.
// Usage: node stt-sidecar.mjs --port=N
// Env: STT_REPLY (text in the partial and final), STT_LOG (activity log).
import net from "node:net";
import crypto from "node:crypto";
import { appendFileSync } from "node:fs";

const port = +(process.argv.find((a) => a.startsWith("--port=")) || "--port=0").split("=")[1];
const reply = process.env.STT_REPLY || "stub heard";
const say = process.env.STT_LOG ? (m) => appendFileSync(process.env.STT_LOG, m + "\n") : () => {};

const accept = (key) =>
  crypto.createHash("sha1").update(key.trim() + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");

// send: one unmasked server frame with the given opcode and payload
// (64-bit lengths are not exercised)
const send = (socket, opcode, payload) => {
  const len = payload.length;
  const head = len < 126
    ? Buffer.from([0x80 | opcode, len])
    : len < 65536
      ? Buffer.concat([Buffer.from([0x80 | opcode, 126]), Buffer.from([(len >> 8) & 0xff, len & 0xff])])
      : null;
  if (len >= 65536) return; // 64-bit frames are not exercised
  socket.write(Buffer.concat([head, payload]));
};

// pullFrames yields { opcode, payload } from a rolling buffer, then runs on
// each; returns the remainder for the next chunk
function frames(buf, onFrame) {
  if (buf.length < 2) return buf;
  const opcode = buf[0] & 0x0f;
  const masked = buf[1] & 0x80;
  let len = buf[1] & 0x7f, off = 2;
  if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { off = 10; len = 0; for (let i = 2; i < 10; i++) len = len * 256 + buf[i]; }
  let mask = null;
  if (masked) { mask = buf.subarray(off, off + 4); off += 4; }
  if (buf.length < off + len) return buf;
  const payload = Buffer.from(buf.subarray(off, off + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  if (onFrame(opcode, payload) === false) return buf;
  return frames(buf.subarray(off + len), onFrame);
}

net.createServer((socket) => {
  let buf = Buffer.alloc(0), up = false, samples = 0, saidDone = false, partial = false;
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!up) {
      const key = /Sec-WebSocket-Key: (\S+)/.exec(buf.toString())?.[1];
      if (!key) return;
      buf = Buffer.alloc(0);
      up = true;
      say("connected");
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept(key) + "\r\n\r\n");
      return;
    }
    buf = frames(buf, (opcode, payload) => {
      if (opcode === 0x8) { say("closed after " + (samples / 16000).toFixed(2) + "s of audio"); socket.end(); return false; }
      if (opcode === 0x1) {
        if (payload.toString() === "Done" && !saidDone) {
          saidDone = true;
          say("done samples=" + (samples / 16000).toFixed(2) + "s");
          send(socket, 0x1, Buffer.from(JSON.stringify({ text: reply, segment: 0, is_final: true, is_eof: false })));
          send(socket, 0x1, Buffer.from(JSON.stringify({ text: reply, segment: process.env.STT_REPEAT ? 1 : 0, is_final: true, is_eof: true })));
          send(socket, 0x1, Buffer.from("Done!"));
        }
        return true;
      }
      if (opcode === 0x2) {
        if (saidDone) say("audio-after-done");
        const before = samples;
        samples += payload.length / 4;
        if (!partial && samples >= 6400) {
          partial = true;
          send(socket, 0x1, Buffer.from(JSON.stringify({ text: reply, segment: 0, is_final: false })));
        }
        if ((before / 16000 | 0) < (samples / 16000 | 0)) say("samples=" + (samples / 16000).toFixed(1) + "s");
      }
      return true;
    });
  });
  socket.on("error", () => {});
}).listen(port, "127.0.0.1", () => say("listening"));

process.on("SIGTERM", () => { say("stopped"); process.exit(0); });
