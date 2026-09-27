import type { Evidence, Scene } from '../learningState';
export type SceneProps = {
  scene: Scene;
  change: (patch: Partial<Scene>, record?: boolean) => void;
  record: (text?: string, kind?: Evidence['kind']) => void;
  reduced: boolean;
  onMediaPlaying?: (playing: boolean) => void;
};
