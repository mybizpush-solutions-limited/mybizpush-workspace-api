import { env } from "../../../config/env";
import { AppError, badRequest } from "../../../lib/errors";
import { transcribeAudio } from "../../../lib/openrouter";

// Audio to text (API-CHANGES A802). The provider is chosen by config and the audio
// is passed straight through, never stored. With no provider, the API says so and
// the app hides the microphone.

export interface Transcript {
  text: string;
  language: string | null;
  durationMs: number | null;
  provider: string;
}
export interface AudioFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}
export type Transcriber = (file: AudioFile, opts: { language?: string }) => Promise<Omit<Transcript, "provider">>;

const AUDIO_EXTENSIONS = [".m4a", ".mp3", ".aac", ".wav", ".ogg", ".webm", ".mp4", ".opus", ".caf", ".3gp"];
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export function assertAudio(name: string): void {
  const lower = name.toLowerCase();
  if (!AUDIO_EXTENSIONS.some((e) => lower.endsWith(e))) throw badRequest(`Audio must be one of ${AUDIO_EXTENSIONS.join(", ")}`);
}

const failure = (provider: string, status: number) => new AppError(502, `Transcription failed (${provider} ${status})`, "transcription_failed");

const openai: Transcriber = async (file, opts) => {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }), file.originalname);
  form.append("model", env.TRANSCRIBE_MODEL || "whisper-1");
  form.append("response_format", "verbose_json");
  if (opts.language) form.append("language", opts.language);
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${env.TRANSCRIBE_API_KEY}` }, body: form });
  if (!res.ok) throw failure("openai", res.status);
  const data = (await res.json()) as { text?: string; language?: string; duration?: number };
  return { text: data.text ?? "", language: data.language ?? opts.language ?? null, durationMs: data.duration != null ? Math.round(data.duration * 1000) : null };
};

const deepgram: Transcriber = async (file, opts) => {
  const params = new URLSearchParams({ model: env.TRANSCRIBE_MODEL || "nova-2", smart_format: "true", ...(opts.language ? { language: opts.language } : { detect_language: "true" }) });
  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: "POST",
    headers: { Authorization: `Token ${env.TRANSCRIBE_API_KEY}`, "Content-Type": file.mimetype || "application/octet-stream" },
    body: new Uint8Array(file.buffer),
  });
  if (!res.ok) throw failure("deepgram", res.status);
  const data = (await res.json()) as { metadata?: { duration?: number }; results?: { channels?: { detected_language?: string; alternatives?: { transcript?: string }[] }[] } };
  const channel = data.results?.channels?.[0];
  return { text: channel?.alternatives?.[0]?.transcript ?? "", language: channel?.detected_language ?? opts.language ?? null, durationMs: data.metadata?.duration != null ? Math.round(data.metadata.duration * 1000) : null };
};

// Audio container to the format names OpenRouter forwards to the model.
const OPENROUTER_FORMATS: Record<string, string> = { ".m4a": "m4a", ".mp4": "m4a", ".mp3": "mp3", ".aac": "aac", ".wav": "wav", ".ogg": "ogg", ".opus": "ogg", ".webm": "webm" };

const openrouter: Transcriber = async (file, opts) => {
  const name = file.originalname.toLowerCase();
  const ext = name.slice(name.lastIndexOf("."));
  const format = OPENROUTER_FORMATS[ext];
  if (!format) throw badRequest("Record in m4a, mp3, wav, aac, ogg or webm for voice input");
  const text = await transcribeAudio(file.buffer, format, { model: env.TRANSCRIBE_MODEL || "google/gemini-2.5-flash", language: opts.language });
  return { text, language: opts.language ?? null, durationMs: null };
};

const PROVIDERS: Record<string, Transcriber> = { openai, deepgram, openrouter };

const keyFor = (provider: string) => (provider === "openrouter" ? env.OPENROUTER_API_KEY : env.TRANSCRIBE_API_KEY);

let override: { name: string; run: Transcriber } | null = null;
export function setTranscriber(t: { name: string; run: Transcriber } | null): void {
  override = t;
}

export const transcribeAvailable = () => !!override || (env.TRANSCRIBE_PROVIDER !== "none" && !!keyFor(env.TRANSCRIBE_PROVIDER) && !!PROVIDERS[env.TRANSCRIBE_PROVIDER]);

export async function transcribe(file: AudioFile, opts: { language?: string } = {}): Promise<Transcript> {
  assertAudio(file.originalname);
  if (!transcribeAvailable()) throw new AppError(503, "Voice input isn't set up on this server", "transcription_unconfigured");
  const name = override?.name ?? env.TRANSCRIBE_PROVIDER;
  const run = override?.run ?? PROVIDERS[env.TRANSCRIBE_PROVIDER]!;
  try {
    return { ...(await run(file, opts)), provider: name };
  } catch (err) {
    if (err instanceof AppError) throw err;
    console.error("[ai] transcription failed", (err as Error).message);
    throw new AppError(502, "Transcription failed", "transcription_failed");
  }
}
