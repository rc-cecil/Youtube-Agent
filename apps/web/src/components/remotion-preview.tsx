import { Player } from '@remotion/player';
import { GameplayShort } from '../../../../packages/remotion/src/GameplayShort.js';
import type { EditDecisionList } from '../../../../packages/remotion/src/edl.js';

export default function RemotionPreview({
  videoSrc,
  sourceWidth,
  sourceHeight,
  hasAudio,
  edl,
  renderFps = 30,
}: {
  videoSrc: string;
  sourceWidth: number;
  sourceHeight: number;
  hasAudio: boolean;
  edl: EditDecisionList;
  renderFps?: number;
}) {
  return (
    <Player
      component={GameplayShort}
      inputProps={{
        videoSrc,
        sourceWidth,
        sourceHeight,
        hasAudio,
        outputWidth: 1080,
        outputHeight: 1920,
        renderFps,
        edl,
        debug: false,
      }}
      durationInFrames={Math.max(1, Math.ceil(edl.outputDuration * renderFps))}
      compositionWidth={1080}
      compositionHeight={1920}
      fps={renderFps}
      controls
      style={{ width: '100%', height: '100%' }}
    />
  );
}
