import { Composition } from 'remotion';
import { GameplayShort } from './GameplayShort.js';
import { gameplayShortPropsSchema, type GameplayShortProps } from './props.js';

const sampleProps: GameplayShortProps = {
  videoSrc: 'sample-gameplay.mp4',
  sourceWidth: 1280,
  sourceHeight: 720,
  hasAudio: true,
  debug: false,
  edl: {
    schemaVersion: 1,
    clipStart: 0,
    clipEnd: 6,
    outputDuration: 6,
    cropStrategy: 'BACKGROUND_BLUR',
    trackedSubject: [],
    hook: { text: 'THE TURNING POINT', start: 0, end: 2.2, position: 'TOP' },
    cuts: [{ sourceStart: 0, sourceEnd: 6, outputStart: 0, speed: 1 }],
    zooms: [{ start: 2.5, end: 3.3, scale: 1.12, focusX: 0.5, focusY: 0.5 }],
    freezeFrames: [],
    replay: null,
    captions: [],
    overlays: [{ type: 'PROGRESS', text: '', start: 0, end: 6, x: 0.5, y: 0.9 }],
    audioInstructions: { preserveOriginal: true, normalize: true, gainDb: 0, ducking: [] },
    title: 'THE TURNING POINT',
    description: 'A gameplay highlight.',
    hashtags: ['#gaming', '#shorts'],
  },
};

export function RemotionRoot() {
  return (
    <Composition
      id="GameplayShort"
      component={GameplayShort}
      width={1080}
      height={1920}
      fps={30}
      durationInFrames={180}
      schema={gameplayShortPropsSchema}
      defaultProps={sampleProps}
      calculateMetadata={({ props }) => ({
        durationInFrames: Math.max(1, Math.ceil(props.edl.outputDuration * 30)),
      })}
    />
  );
}
