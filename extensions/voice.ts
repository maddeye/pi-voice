import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { PvRecorder } from "@picovoice/pvrecorder-node";
import {
  BorderedLoader,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

const WHISPER_MODELS = {
  "Tiny (fastest)": "Xenova/whisper-tiny",
  "Base (balanced)": "Xenova/whisper-base",
  "Small (best accuracy)": "Xenova/whisper-small",
} as const;
type WhisperModel = (typeof WHISPER_MODELS)[keyof typeof WHISPER_MODELS];

interface VoiceConfig {
  deviceName?: string;
  language?: string;
  maxSeconds?: number;
  model?: WhisperModel;
}

const CONFIG_PATH = join(getAgentDir(), "pi-voice.json");
const MODEL_CACHE = join(getAgentDir(), "pi-voice-models");
const DEFAULT_MAX_SECONDS = 120;
const DEFAULT_MODEL: WhisperModel = "Xenova/whisper-base";
const DEFAULT_SHORTCUT = "alt+m";
const SHORTCUT_SETTING = "pi-voice.record";

export function parseVoiceShortcuts(value: unknown): string[] {
  if (!value || typeof value !== "object" || !(SHORTCUT_SETTING in value)) return [DEFAULT_SHORTCUT];
  const configured = (value as Record<string, unknown>)[SHORTCUT_SETTING];
  if (Array.isArray(configured) && configured.length === 0) return [];
  const shortcuts = Array.isArray(configured) ? configured : [configured];
  const valid = [...new Set(shortcuts.filter((key): key is string => typeof key === "string" && key.trim().length > 0).map((key) => key.trim()))];
  return valid.length ? valid : [DEFAULT_SHORTCUT];
}

function loadVoiceShortcuts(): string[] {
  try {
    return parseVoiceShortcuts(JSON.parse(readFileSync(join(getAgentDir(), "keybindings.json"), "utf8")));
  } catch {
    return [DEFAULT_SHORTCUT];
  }
}

type LocalTranscriber = ((audio: Float32Array, options: Record<string, unknown>) => Promise<{ text: string }>) & {
  dispose(): void | Promise<void>;
};
let transcriber: LocalTranscriber | undefined;
let loadedModel: WhisperModel | undefined;

async function getTranscriber(model: WhisperModel): Promise<LocalTranscriber> {
  if (transcriber && loadedModel === model) return transcriber;
  const previous = transcriber;
  transcriber = undefined;
  loadedModel = undefined;
  await previous?.dispose();
  await mkdir(MODEL_CACHE, { recursive: true });
  const { env, pipeline } = await import("@huggingface/transformers");
  env.cacheDir = MODEL_CACHE;
  const loaded = await pipeline("automatic-speech-recognition", model, { dtype: "q8" }) as unknown as LocalTranscriber;
  transcriber = loaded;
  loadedModel = model;
  return loaded;
}

export function parseConfig(value: unknown): VoiceConfig {
  if (!value || typeof value !== "object") return {};
  const input = value as Record<string, unknown>;
  const config: VoiceConfig = {};
  if (typeof input.deviceName === "string" && input.deviceName.length <= 512) config.deviceName = input.deviceName;
  if (typeof input.language === "string" && /^[a-z]{2}$/i.test(input.language)) config.language = input.language.toLowerCase();
  if (Number.isInteger(input.maxSeconds) && Number(input.maxSeconds) >= 5 && Number(input.maxSeconds) <= 600) {
    config.maxSeconds = Number(input.maxSeconds);
  }
  if (typeof input.model === "string" && Object.values(WHISPER_MODELS).includes(input.model as WhisperModel)) {
    config.model = input.model as WhisperModel;
  }
  return config;
}

export function pcmToFloat32(frames: Int16Array[]): Float32Array {
  const audio = new Float32Array(frames.reduce((count, frame) => count + frame.length, 0));
  let offset = 0;
  for (const frame of frames) {
    for (const sample of frame) audio[offset++] = sample / 32768;
  }
  return audio;
}

async function loadConfig(): Promise<VoiceConfig> {
  try {
    const raw = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    const config = parseConfig(raw);
    if (raw && typeof raw === "object" && "apiKey" in raw) await saveConfig(config);
    return config;
  } catch {
    return {};
  }
}

async function saveConfig(config: VoiceConfig): Promise<void> {
  await mkdir(getAgentDir(), { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(CONFIG_PATH, 0o600);
}

function availableDevices(): string[] {
  return PvRecorder.getAvailableDevices();
}

async function configure(ctx: ExtensionContext): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/voice-settings requires TUI mode", "error");
    return;
  }

  const old = await loadConfig();
  const devices = availableDevices();
  const selectedDevice = await ctx.ui.select("Voice microphone", ["System default", ...devices]);
  if (!selectedDevice) return;

  const languageChoice = await ctx.ui.select("Whisper language", ["en", "de", "es", "fr", "Other ISO-639-1 code"]);
  if (!languageChoice) return;
  let language = languageChoice;
  if (languageChoice === "Other ISO-639-1 code") {
    const input = await ctx.ui.input("Two-letter language code", old.language ?? "en");
    if (input === undefined) return;
    language = input.trim().toLowerCase();
    if (!/^[a-z]{2}$/.test(language)) {
      ctx.ui.notify("Language must be a two-letter ISO-639-1 code", "error");
      return;
    }
  }

  const duration = await ctx.ui.select("Maximum recording length", ["30 seconds", "60 seconds", "120 seconds", "300 seconds", "600 seconds"]);
  if (!duration) return;

  const modelLabel = await ctx.ui.select("Local Whisper model", Object.keys(WHISPER_MODELS));
  if (!modelLabel) return;

  await saveConfig({
    deviceName: selectedDevice === "System default" ? undefined : selectedDevice,
    language,
    maxSeconds: Number.parseInt(duration, 10),
    model: WHISPER_MODELS[modelLabel as keyof typeof WHISPER_MODELS],
  });
  ctx.ui.notify(`Voice settings saved to ${CONFIG_PATH}`, "info");
}

async function record(ctx: ExtensionContext, config: VoiceConfig): Promise<Float32Array | null> {
  const devices = availableDevices();
  const deviceIndex = config.deviceName ? devices.indexOf(config.deviceName) : -1;
  if (config.deviceName && deviceIndex < 0) ctx.ui.notify(`Microphone “${config.deviceName}” not found; using system default`, "warning");

  const recorder = new PvRecorder(512, deviceIndex);
  const frames: Int16Array[] = [];
  let capturing = true;
  let captureFailure: unknown;
  let cleanupFailure: unknown;
  let finish = (_save: boolean) => {};
  let capture = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  let save = false;

  try {
    if (recorder.sampleRate !== 16_000) {
      throw new Error(`Local Whisper requires 16 kHz audio; recorder returned ${recorder.sampleRate} Hz`);
    }
    const maxSamples = recorder.sampleRate * (config.maxSeconds ?? DEFAULT_MAX_SECONDS);
    recorder.start();
    capture = (async () => {
      try {
        while (capturing && frames.length * recorder.frameLength < maxSamples) frames.push(await recorder.read());
        if (capturing) finish(true);
      } catch (error) {
        if (capturing) {
          captureFailure = error;
          finish(false);
        }
      }
    })();

    const started = Date.now();
    save = await ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
      finish = done;
      timer = setInterval(() => tui.requestRender(), 250);
      return {
        render(width: number) {
          const seconds = ((Date.now() - started) / 1000).toFixed(1);
          return [
            truncateToWidth(theme.fg("error", theme.bold(`● Recording ${seconds}s`)), width),
            truncateToWidth(theme.fg("dim", "Enter stop and transcribe • Esc cancel"), width),
          ];
        },
        invalidate() {},
        handleInput(data: string) {
          if (matchesKey(data, Key.enter)) done(true);
          else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) done(false);
        },
      };
    });
  } finally {
    if (timer) clearInterval(timer);
    capturing = false;
    try {
      if (recorder.isRecording) recorder.stop();
    } catch (error) {
      cleanupFailure = error;
    }
    await capture;
    try {
      recorder.release();
    } catch (error) {
      cleanupFailure ??= error;
    }
  }

  if (captureFailure) throw captureFailure;
  if (cleanupFailure) throw cleanupFailure;
  return save && frames.length ? pcmToFloat32(frames) : null;
}

async function transcribe(ctx: ExtensionContext, audio: Float32Array, config: VoiceConfig): Promise<string | null> {
  let failure: unknown;
  const result = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
    const model = config.model ?? DEFAULT_MODEL;
    const loader = new BorderedLoader(tui, theme, `Running ${model} locally (first use downloads the model)...`, { cancellable: false });
    getTranscriber(model)
      .then((pipe) => pipe(audio, {
        ...(config.language ? { language: config.language } : {}),
        task: "transcribe",
        chunk_length_s: 30,
        stride_length_s: 5,
      }))
      .then((output) => done(output.text.trim()))
      .catch((error) => {
        failure = error;
        done(null);
      });
    return loader;
  });
  if (failure) throw failure;
  return result;
}

export default function voiceExtension(pi: ExtensionAPI) {
  let busy = false;

  const run = async (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return ctx.ui.notify("Voice input requires TUI mode", "error");
    if (!ctx.isIdle()) return ctx.ui.notify("Wait for pi to finish before recording", "warning");
    if (busy) return ctx.ui.notify("Voice input is already active", "warning");
    busy = true;
    try {
      const config = await loadConfig();
      const audio = await record(ctx, config);
      if (!audio) return ctx.ui.notify("Voice recording cancelled", "info");
      const text = await transcribe(ctx, audio, config);
      if (!text) return ctx.ui.notify("No speech detected", "warning");
      const current = ctx.ui.getEditorText().trimEnd();
      ctx.ui.setEditorText(current ? `${current} ${text}` : text);
      ctx.ui.notify("Transcription added to the prompt", "info");
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    } finally {
      busy = false;
    }
  };

  pi.registerCommand("voice", { description: "Record and transcribe voice into the prompt", handler: (_args, ctx) => run(ctx) });
  pi.registerCommand("voice-settings", {
    description: "Configure voice input",
    handler: async (_args, ctx) => {
      try {
        await configure(ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
  const shortcuts = loadVoiceShortcuts();
  for (const shortcut of shortcuts) {
    pi.registerShortcut(shortcut as Parameters<typeof pi.registerShortcut>[0], { description: "Record a voice prompt", handler: run });
  }
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setStatus("pi-voice", shortcuts.length ? `voice: ${shortcuts.join(", ")}` : "voice: /voice");
  });
  pi.on("session_shutdown", async () => {
    const loaded = transcriber;
    transcriber = undefined;
    loadedModel = undefined;
    await loaded?.dispose();
  });
}
