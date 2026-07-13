import assert from "node:assert/strict";
import test from "node:test";
import { pcmToFloat32, parseConfig, parseVoiceShortcuts, waveformBar } from "../extensions/voice.ts";

test("pcmToFloat32 joins and normalizes recorded frames", () => {
  const audio = pcmToFloat32([Int16Array.from([-32768, 0]), Int16Array.from([16384, 32767])]);
  assert.deepEqual([...audio], [-1, 0, 0.5, 32767 / 32768]);
  assert.equal(pcmToFloat32([]).length, 0);
});

test("waveformBar shows silence as a dot and speech as a scaled bar", () => {
  assert.equal(waveformBar(Int16Array.of(0, 30)), "·");
  assert.equal(waveformBar(Int16Array.of(100, -100)), "▂");
  assert.equal(waveformBar(Int16Array.of(300, -300)), "▄");
  assert.equal(waveformBar(Int16Array.of(1000, -1000)), "█");
  assert.equal(waveformBar(Int16Array.of(32767, -32768)), "█");
});

test("parseVoiceShortcuts defaults, overrides, and disables", () => {
  assert.deepEqual(parseVoiceShortcuts({}), ["alt+m"]);
  assert.deepEqual(parseVoiceShortcuts({ "pi-voice.record": ["alt+r", " alt+r ", "ctrl+r"] }), ["alt+r", "ctrl+r"]);
  assert.deepEqual(parseVoiceShortcuts({ "pi-voice.record": [] }), []);
  assert.deepEqual(parseVoiceShortcuts({ "pi-voice.record": 42 }), ["alt+m"]);
  assert.deepEqual(parseVoiceShortcuts({ "pi-voice.record": [null, ""] }), ["alt+m"]);
});

test("parseConfig accepts only bounded settings and known models", () => {
  assert.deepEqual(parseConfig({
    language: "EN",
    maxSeconds: 60,
    deviceName: "Mic",
    model: "Xenova/whisper-tiny",
    apiKey: "ignored",
  }), {
    language: "en",
    maxSeconds: 60,
    deviceName: "Mic",
    model: "Xenova/whisper-tiny",
  });
  assert.equal(parseConfig({ maxSeconds: 5 }).maxSeconds, 5);
  assert.equal(parseConfig({ maxSeconds: 600 }).maxSeconds, 600);
  assert.deepEqual(parseConfig({ language: "english", maxSeconds: 4, deviceName: 4, model: "unknown" }), {});
  assert.deepEqual(parseConfig({ maxSeconds: 601 }), {});
  assert.deepEqual(parseConfig(null), {});
});
