import { Composition } from 'remotion';
import { GameplayShort } from './GameplayShort.js';
import { gameplayShortPropsSchema, type GameplayShortProps } from './props.js';

const sampleProps: GameplayShortProps = {
  videoSrc: 'sample-gameplay.mp4',
  sourceWidth: 1280,
  sourceHeight: 720,
  hasAudio: true,
  outputWidth: 1080,
  outputHeight: 1920,
  renderFps: 30,
  debug: false,
  edl: {
    schemaVersion: 2,
    sourceVideoId: 'studio-source',
    eventId: 'studio-event',
    candidateId: 'studio-candidate',
    analysisVersion: 'analysis-v2',
    detectorVersion: 'detectors-v2',
    scoringVersion: 'scoring-v2',
    editVersion: 'edit-v2',
    clipStart: 0,
    clipEnd: 6,
    outputDuration: 6,
    eventAnchors: { eventStart: 0.8, keyMoment: 3, payoffEnd: 5.2 },
    durationClass: 'MICRO',
    durationReason: 'Studio fixture preserves setup, action, and payoff.',
    cropStrategy: 'SMART_CROP',
    cropSubject: null,
    trackingConfidence: 0,
    trackingPolicyVersion: 'tracking-policy-v1',
    fallbackStrategy: 'SMART_CROP',
    trackedSubject: [],
    safeRegions: [],
    hook: {
      type: 'PAYOFF_TEASE',
      text: 'THE TURNING POINT',
      start: 0,
      end: 1.4,
      position: 'TOP',
    },
    cuts: [
      {
        sourceStart: 0,
        sourceEnd: 6,
        outputStart: 0,
        speed: 1,
        reason: 'Preserve the complete studio event',
      },
    ],
    zooms: [
      {
        start: 2.5,
        end: 3.3,
        scale: 1.12,
        focusX: 0.5,
        focusY: 0.5,
        reason: 'Emphasize the fixture key moment',
      },
    ],
    freezeFrames: [],
    replays: [],
    replay: null,
    captions: [
      {
        text: 'THE PACE SPIKED',
        start: 2.5,
        end: 4.1,
        emphasis: ['SPIKED'],
        position: 'BOTTOM',
        kind: 'PHRASE',
        tokens: [],
      },
    ],
    overlays: [
      {
        type: 'PROGRESS',
        text: '',
        start: 0,
        end: 6,
        x: 0.5,
        y: 0.9,
        reason: 'Show remaining fixture time',
      },
    ],
    soundEffects: [],
    audioInstructions: { preserveOriginal: true, normalize: true, gainDb: 0, ducking: [] },
    editorialRole: 'HERO',
    editingIntensity: 'MEDIUM',
    concept: 'A complete turning-point gameplay moment.',
    title: 'THE TURNING POINT',
    titleCandidates: ['THE TURNING POINT'],
    description: 'A gameplay highlight.',
    hashtags: ['#gaming', '#shorts'],
    analysisMethod: 'AI',
    highlightScore: 90,
    shortWorthinessScore: 92,
    duplicateScore: 0.04,
    reasoningSummary: 'Clear setup, visible action, and an immediate payoff.',
  },
};

const studioVariants: Array<{
  id: string;
  title: string;
  strategy: GameplayShortProps['edl']['cropStrategy'];
}> = [
  { id: 'Studio-EA-Sports-FC', title: 'EA SPORTS FC — GOAL BUILD-UP', strategy: 'SMART_CROP' },
  { id: 'Studio-Call-of-Duty', title: 'CALL OF DUTY — FAST ELIMINATION', strategy: 'CENTER_CROP' },
  { id: 'Studio-GTA', title: 'GTA — CHASE PAYOFF', strategy: 'BLURRED_BACKGROUND' },
  { id: 'Studio-Fortnite', title: 'FORTNITE — CLUTCH FINISH', strategy: 'STACKED' },
];

function variantProps(variant: (typeof studioVariants)[number]): GameplayShortProps {
  return {
    ...sampleProps,
    edl: {
      ...sampleProps.edl,
      cropStrategy: variant.strategy,
      fallbackStrategy:
        variant.strategy === 'BLURRED_BACKGROUND' ? 'BLURRED_BACKGROUND' : 'SMART_CROP',
      title: variant.title,
      titleCandidates: [variant.title],
      concept: `${variant.title} Studio fixture for inspecting framing, captions, audio, and editorial timing.`,
      description: `${variant.title} Remotion Studio preview.`,
      hook: sampleProps.edl.hook
        ? { ...sampleProps.edl.hook, text: variant.title.split(' — ')[1]! }
        : null,
    },
  };
}

const calculateMetadata = ({ props }: { props: GameplayShortProps }) => ({
  durationInFrames: Math.max(1, Math.ceil(props.edl.outputDuration * props.renderFps)),
  fps: props.renderFps,
  width: props.outputWidth,
  height: props.outputHeight,
});

export function RemotionRoot() {
  return (
    <>
      <Composition
        id="GameplayShort"
        component={GameplayShort}
        width={1080}
        height={1920}
        fps={30}
        durationInFrames={180}
        schema={gameplayShortPropsSchema}
        defaultProps={sampleProps}
        calculateMetadata={calculateMetadata}
      />
      {studioVariants.map((variant) => (
        <Composition
          key={variant.id}
          id={variant.id}
          component={GameplayShort}
          width={1080}
          height={1920}
          fps={30}
          durationInFrames={180}
          schema={gameplayShortPropsSchema}
          defaultProps={variantProps(variant)}
          calculateMetadata={calculateMetadata}
        />
      ))}
    </>
  );
}
