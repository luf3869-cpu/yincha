export type SongChange = {
  process: string;
  title: string;
  pid?: number;
};

export type CableSetupResult = {
  ok: boolean;
  error?: string;
  cableIn?: string;
  cableOut?: string;
  listenDevice?: string;
};

export type AudioRestoreResult = {
  ok: boolean;
  restored?: boolean;
  playbackName?: string;
  recordingName?: string;
  error?: string;
};

declare global {
  interface Window {
    yinchaDesktop?: {
      platform: string;
      setupCable?: (output?: "speakers" | "headphones") => Promise<CableSetupResult>;
      restoreAudio?: () => Promise<AudioRestoreResult>;
      watchSongs?: (enabled: boolean) => Promise<{ ok: boolean }>;
      onSongChange?: (handler: (song: SongChange) => void) => () => void;
    };
  }
}
