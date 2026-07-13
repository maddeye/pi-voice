# pi voice

Private voice prompt input for [pi](https://github.com/earendil-works/pi-mono), transcribed locally with Whisper. Recorded audio is kept in memory and never uploaded or written to disk.

## Install

After the npm release:

```bash
pi install npm:@maddeye/pi-voice
```

From a local checkout:

```bash
pi install /absolute/path/to/pi-voice
```

Run `/voice-settings` once, then press **Alt+M** or run `/voice`. Press **Enter** to stop recording or **Esc** to cancel. The transcription is placed in the prompt editor for review; it is never submitted automatically.

## Configuration

`/voice-settings` configures the microphone, language, maximum recording length, and local model entirely inside the pi TUI. Defaults are the system microphone, English, 120 seconds, and Whisper Base.

The shortcut uses pi's normal `~/.pi/agent/keybindings.json`. Change it and run `/reload`:

```json
{
  "pi-voice.record": "alt+r"
}
```

Use an array for multiple shortcuts or `[]` to disable the shortcut.

Settings are stored in `~/.pi/agent/pi-voice.json` (or the configured pi agent directory). Models are downloaded from Hugging Face on first use and cached in `pi-voice-models/`; after that, transcription works offline. Tiny is fastest, Base is the default, and Small favors accuracy.

> **Disk usage:** Runtime dependencies use about **538 MB**, mostly ONNX Runtime’s cross-platform binaries. The default quantized Whisper Base model adds about **77 MB**, for roughly **615 MB total**. Other models and package versions may vary; keep at least **1 GB free**.

## Privacy

- Microphone samples remain in process memory only.
- Audio is sent only to the local Whisper model.
- The first use of each model downloads model files from Hugging Face.
- No API key is required.

## Compatibility

- Linux x86_64
- macOS x86_64 and arm64
- Windows x86_64 and arm64
- Node.js 22.19 or newer

The terminal running pi needs microphone permission. Native audio and ONNX binaries are included by the runtime dependencies.

## Troubleshooting

- **No microphone / permission denied:** grant microphone access to your terminal in macOS Privacy & Security or Windows Privacy & security. On Linux, verify PipeWire/PulseAudio can see the device.
- **Configured microphone disappeared:** rerun `/voice-settings`; recording falls back to the system default.
- **Model download failed:** check network access to `huggingface.co`, then retry `/voice`.
- **Native module unsupported:** verify the OS/architecture and Node version listed above.
- **Slow transcription:** select Tiny in `/voice-settings`.

## Upgrade and removal

```bash
pi update npm:@maddeye/pi-voice
pi remove npm:@maddeye/pi-voice
```

Removing the package does not remove downloaded models. Delete `~/.pi/agent/pi-voice-models/` and `~/.pi/agent/pi-voice.json` to remove cached data and settings.

## Development

```bash
npm ci
npm run check
pi -e ./extensions/voice.ts
```

Before release, verify one real recording on every supported OS/architecture.
