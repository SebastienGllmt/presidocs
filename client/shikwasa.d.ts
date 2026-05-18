declare module "shikwasa/dist/style.css";

declare module "shikwasa" {
  export interface ShikwasaChapter {
    title: string;
    startTime: number;
    endTime: number;
  }

  export interface ShikwasaAudio {
    title?: string;
    artist?: string;
    cover?: string;
    src: string;
    duration?: number;
    chapters?: ShikwasaChapter[];
  }

  export interface ShikwasaOptions {
    container: HTMLElement;
    fixed?: { type: "static" | "fixed" | "auto" };
    theme?: "light" | "dark" | "auto";
    themeColor?: string;
    speedOptions?: number[];
    preload?: "none" | "metadata" | "auto";
    audio: ShikwasaAudio;
  }

  export type PlayerEvent =
    | "play"
    | "pause"
    | "ended"
    | "seeked"
    | "timeupdate"
    | "chapterchange"
    | "canplay"
    | "loadedmetadata";

  export class Player {
    constructor(options: ShikwasaOptions);
    static use(plugin: unknown): void;
    readonly currentTime: number;
    readonly audio?: HTMLAudioElement;
    play(): void;
    pause(): void;
    toggle(): void;
    seek(time: number): void;
    on(event: PlayerEvent, handler: () => void): void;
  }

  export const Chapter: unknown;
}
