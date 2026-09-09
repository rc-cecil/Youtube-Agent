import { Player } from '@remotion/player';
import { GameplayShort } from '../../../../packages/remotion/src/GameplayShort.js';
import type { EditDecisionList } from '../../../../packages/remotion/src/edl.js';

export default function RemotionPreview({
  videoSrc,
  sourceWidth,
  sourceHeight,
  hasAudio,
  edl,
}: {
  videoSrc: string;
  sourceWidth: number;
  sourceHeight: number;
  hasAudio: boolean;
  edl: EditDecisionList;
}) {
  return (
    <Player
      component={GameplayShort}
      inputProps={{ videoSrc, sourceWidth, sourceHeight, hasAudio, edl, debug: false }}
      durationInFrames={Math.max(1, Math.ceil(edl.outputDuration * 30))}
      compositionWidth={1080}
      compositionHeight={1920}
      fps={30}
      controls
      style={{ width: '100%', height: '100%' }}
    />
  );
}
