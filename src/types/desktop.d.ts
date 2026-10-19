export type SongChange = {
  process: string;
  title: string;
  pid?: number;
};

export type ListenDevice = {
  id: string;
  name: string;
  deviceName: string;
};

export type AudioPhase = "checking" | "idle" | "engaging" | "engaged" | "releasing" | "error";

export type AudioState = {
  phase: AudioPhase;
  message: string;
  recovered: boolean;
  listen: ListenDevice | null;
};

export type EngageResult = {
  ok: boolean;
  error?: string;
  listen?: ListenDevice;
};

export type ReleaseResult = {
  ok: boolean;
  restored?: boolean;
  error?: string;
};

declare global {
  interface Window {
    yinchaDesktop?: {
      platform: string;
      audioState?: () => Promise<AudioState>;
      onAudioState?: (handler: (state: AudioState) => void) => () => void;
      engage?: () => Promise<EngageResult>;
      release?: () => Promise<ReleaseResult>;
      watchSongs?: (enabled: boolean) => Promise<{ ok: boolean }>;
      onSongChange?: (handler: (song: SongChange) => void) => () => void;
    };
  }
}
