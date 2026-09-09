import type { CSSProperties, ReactNode } from 'react';
import {
  AbsoluteFill,
  Easing,
  Freeze,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { Video } from '@remotion/media';
import type { CropStrategy, EditDecisionList } from './edl.js';
import type { GameplayShortProps } from './props.js';

const safe: CSSProperties = { left: 80, right: 80, top: 112, bottom: 124 };

function sourceUrl(value: string) {
  return /^(https?:|data:|blob:|\/)/.test(value) ? value : staticFile(value);
}

function clip(value: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function splitMediaStyle(style: CSSProperties) {
  const { objectFit, ...videoStyle } = style;
  const mediaObjectFit = objectFit === 'cover' || objectFit === 'contain' ? objectFit : undefined;
  return { objectFit: mediaObjectFit, videoStyle };
}

function trackedFocus(edl: EditDecisionList, time: number) {
  if (!edl.trackedSubject.length) return { x: 0.5, y: 0.5 };
  const after =
    edl.trackedSubject.find((point) => point.time >= time) ?? edl.trackedSubject.at(-1)!;
  const index = edl.trackedSubject.indexOf(after);
  const before = edl.trackedSubject[Math.max(0, index - 1)] ?? after;
  if (after.time === before.time) return { x: after.x, y: after.y };
  const amount = clip((time - before.time) / (after.time - before.time));
  return {
    x: interpolate(amount, [0, 1], [before.x, after.x]),
    y: interpolate(amount, [0, 1], [before.y, after.y]),
  };
}

function videoStyle(
  strategy: CropStrategy,
  sourceWidth: number,
  sourceHeight: number,
  focus: { x: number; y: number },
): CSSProperties {
  const landscape = sourceWidth / sourceHeight > 9 / 16;
  if (strategy === 'BACKGROUND_BLUR')
    return { width: '100%', height: '100%', objectFit: 'contain', position: 'absolute' };
  if (strategy === 'STACKED')
    return { width: '100%', height: '52%', objectFit: 'cover', position: 'absolute', top: '24%' };
  return {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    objectPosition: `${focus.x * 100}% ${focus.y * 100}%`,
    position: 'absolute',
    transform: landscape && strategy === 'CENTER' ? 'scale(1)' : undefined,
  };
}

function FramedVideo({
  children,
  strategy,
  sourceWidth,
  sourceHeight,
  focus,
}: {
  children: (style: CSSProperties, decorative?: boolean) => ReactNode;
  strategy: CropStrategy;
  sourceWidth: number;
  sourceHeight: number;
  focus: { x: number; y: number };
}) {
  const foreground = videoStyle(strategy, sourceWidth, sourceHeight, focus);
  if (strategy === 'BACKGROUND_BLUR')
    return (
      <AbsoluteFill style={{ background: '#050607', overflow: 'hidden' }}>
        {children(
          {
            width: '115%',
            height: '115%',
            objectFit: 'cover',
            filter: 'blur(42px) brightness(.42)',
            position: 'absolute',
            left: '-7.5%',
            top: '-7.5%',
          },
          true,
        )}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'linear-gradient(180deg,rgba(0,0,0,.28),transparent 30%,transparent 72%,rgba(0,0,0,.36))',
          }}
        />
        {children(foreground)}
      </AbsoluteFill>
    );
  if (strategy === 'STACKED')
    return (
      <AbsoluteFill style={{ background: '#050607' }}>
        {children({ ...foreground, top: 0, height: '50%', objectPosition: '50% 30%' })}
        {children({ ...foreground, top: '50%', height: '50%', objectPosition: '50% 70%' }, true)}
      </AbsoluteFill>
    );
  if (strategy === 'GAMEPLAY_PLUS_FACE_CAM')
    return (
      <AbsoluteFill style={{ background: '#050607' }}>
        {children({ ...foreground, height: '74%' })}
        {children(
          {
            position: 'absolute',
            left: 64,
            right: 64,
            bottom: 64,
            height: '22%',
            objectFit: 'cover',
            objectPosition: '85% 15%',
            borderRadius: 28,
            border: '4px solid rgba(255,255,255,.8)',
          },
          true,
        )}
      </AbsoluteFill>
    );
  return (
    <AbsoluteFill style={{ overflow: 'hidden', background: '#050607' }}>
      {children(foreground)}
    </AbsoluteFill>
  );
}

function GameplayVideo({ props }: { props: GameplayShortProps }) {
  const frame = useCurrentFrame(),
    { fps } = useVideoConfig(),
    time = frame / fps;
  return (
    <AbsoluteFill>
      {props.edl.cuts.map((cut, index) => {
        const duration = (cut.sourceEnd - cut.sourceStart) / cut.speed;
        return (
          <Sequence
            key={`${cut.sourceStart}-${index}`}
            from={Math.round(cut.outputStart * fps)}
            durationInFrames={Math.max(1, Math.round(duration * fps))}
          >
            <FramedVideo
              strategy={props.edl.cropStrategy}
              sourceWidth={props.sourceWidth}
              sourceHeight={props.sourceHeight}
              focus={trackedFocus(props.edl, time)}
            >
              {(style, decorative) => {
                const { objectFit, videoStyle: mediaStyle } = splitMediaStyle(style);
                return (
                  <Video
                    src={sourceUrl(props.videoSrc)}
                    trimBefore={Math.round(cut.sourceStart * fps)}
                    playbackRate={cut.speed}
                    muted={
                      decorative || !props.hasAudio || !props.edl.audioInstructions.preserveOriginal
                    }
                    volume={(localFrame) => {
                      const outputTime = cut.outputStart + localFrame / fps;
                      const duck = props.edl.audioInstructions.ducking.find(
                        (item) => outputTime >= item.start && outputTime <= item.end,
                      );
                      return (
                        10 ** ((props.edl.audioInstructions.gainDb + (duck?.gainDb ?? 0)) / 20)
                      );
                    }}
                    objectFit={objectFit}
                    style={mediaStyle}
                  />
                );
              }}
            </FramedVideo>
          </Sequence>
        );
      })}
      {props.edl.replay ? (
        <Sequence
          from={Math.round(props.edl.replay.outputStart * fps)}
          durationInFrames={Math.max(
            1,
            Math.round(
              ((props.edl.replay.sourceEnd - props.edl.replay.sourceStart) /
                props.edl.replay.speed) *
                fps,
            ),
          )}
        >
          <FramedVideo
            strategy={props.edl.cropStrategy}
            sourceWidth={props.sourceWidth}
            sourceHeight={props.sourceHeight}
            focus={{ x: 0.5, y: 0.5 }}
          >
            {(style, decorative) => {
              const { objectFit, videoStyle: mediaStyle } = splitMediaStyle(style);
              return (
                <Video
                  src={sourceUrl(props.videoSrc)}
                  trimBefore={Math.round(props.edl.replay!.sourceStart * fps)}
                  playbackRate={props.edl.replay!.speed}
                  muted={decorative || !props.hasAudio}
                  objectFit={objectFit}
                  style={mediaStyle}
                />
              );
            }}
          </FramedVideo>
        </Sequence>
      ) : null}
      {props.edl.freezeFrames.map((freeze, index) => (
        <Sequence
          key={`freeze-${index}`}
          from={Math.round(freeze.start * fps)}
          durationInFrames={Math.max(1, Math.round((freeze.end - freeze.start) * fps))}
        >
          <Freeze frame={0}>
            <FramedVideo
              strategy={props.edl.cropStrategy}
              sourceWidth={props.sourceWidth}
              sourceHeight={props.sourceHeight}
              focus={trackedFocus(props.edl, freeze.start)}
            >
              {(style) => {
                const { objectFit, videoStyle: mediaStyle } = splitMediaStyle(style);
                return (
                  <Video
                    src={sourceUrl(props.videoSrc)}
                    trimBefore={Math.round(freeze.sourceTime * fps)}
                    muted
                    objectFit={objectFit}
                    style={mediaStyle}
                  />
                );
              }}
            </FramedVideo>
          </Freeze>
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}

function GameplayLayer({ props }: { props: GameplayShortProps }) {
  const frame = useCurrentFrame(),
    { fps } = useVideoConfig(),
    time = frame / fps;
  const zoom = props.edl.zooms.find((item) => time >= item.start && time <= item.end);
  const scale = zoom
    ? interpolate(time, [zoom.start, (zoom.start + zoom.end) / 2, zoom.end], [1, zoom.scale, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    : 1;
  return (
    <AbsoluteFill
      style={{
        transform: `scale(${scale})`,
        transformOrigin: zoom ? `${zoom.focusX * 100}% ${zoom.focusY * 100}%` : '50% 50%',
      }}
    >
      <GameplayVideo props={props} />
    </AbsoluteFill>
  );
}

function HookText({ edl }: { edl: EditDecisionList }) {
  const frame = useCurrentFrame(),
    { fps } = useVideoConfig(),
    local = frame - edl.hook.start * fps;
  if (frame / fps > edl.hook.end) return null;
  const scale = interpolate(local, [0, 5, 12], [0.88, 1.06, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  const opacity = interpolate(local, [0, 3], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <div
      style={{
        position: 'absolute',
        ...safe,
        bottom: 'auto',
        top: edl.hook.position === 'TOP' ? 118 : 720,
        display: 'flex',
        justifyContent: 'center',
        opacity,
        transform: `scale(${scale})`,
      }}
    >
      <div
        style={{
          color: '#fff',
          fontFamily: 'Inter, Arial, sans-serif',
          fontSize: 92,
          lineHeight: 0.98,
          fontWeight: 950,
          letterSpacing: '-.055em',
          textAlign: 'center',
          textTransform: 'uppercase',
          textShadow: '0 5px 0 #08090a,0 9px 26px rgba(0,0,0,.82)',
          WebkitTextStroke: '2px rgba(0,0,0,.7)',
        }}
      >
        {edl.hook.text}
      </div>
    </div>
  );
}

function CaptionLayer({ edl }: { edl: EditDecisionList }) {
  const frame = useCurrentFrame(),
    { fps } = useVideoConfig(),
    time = frame / fps;
  const caption = edl.captions.find((item) => time >= item.start && time < item.end);
  if (!caption) return null;
  return (
    <div
      style={{
        position: 'absolute',
        ...safe,
        top: caption.position === 'TOP' ? 320 : caption.position === 'MIDDLE' ? 780 : 'auto',
        bottom: caption.position === 'BOTTOM' ? 230 : 'auto',
        display: 'flex',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          maxWidth: 900,
          color: '#fff',
          background: 'rgba(5,6,7,.76)',
          border: '2px solid rgba(255,255,255,.16)',
          borderRadius: 24,
          padding: '18px 28px',
          fontFamily: 'Inter, Arial, sans-serif',
          fontSize: 64,
          lineHeight: 1.08,
          fontWeight: 850,
          textAlign: 'center',
          textWrap: 'balance',
          boxShadow: '0 18px 50px rgba(0,0,0,.35)',
        }}
      >
        {caption.text}
      </div>
    </div>
  );
}

function Effects({ edl }: { edl: EditDecisionList }) {
  const frame = useCurrentFrame(),
    { fps } = useVideoConfig(),
    time = frame / fps;
  const overlays = edl.overlays.filter((item) => time >= item.start && time <= item.end);
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {edl.replay && time >= edl.replay.outputStart ? (
        <div
          style={{
            position: 'absolute',
            top: 112,
            right: 80,
            color: '#d7ff45',
            background: '#050607cc',
            borderRadius: 12,
            padding: '12px 18px',
            font: '900 34px Inter, Arial, sans-serif',
            letterSpacing: '.08em',
          }}
        >
          {edl.replay.label}
        </div>
      ) : null}
      {overlays.map((item, index) => {
        if (item.type === 'PROGRESS')
          return (
            <div
              key={index}
              style={{
                position: 'absolute',
                left: 0,
                bottom: 0,
                height: 10,
                width: `${clip(time / edl.outputDuration) * 100}%`,
                background: '#d7ff45',
              }}
            />
          );
        if (item.type === 'CIRCLE')
          return (
            <div
              key={index}
              style={{
                position: 'absolute',
                left: `${item.x * 100}%`,
                top: `${item.y * 100}%`,
                width: 170,
                height: 170,
                borderRadius: '50%',
                border: '12px solid #d7ff45',
                transform: 'translate(-50%,-50%)',
                boxShadow: '0 0 24px rgba(215,255,69,.5)',
              }}
            />
          );
        if (item.type === 'ARROW')
          return (
            <div
              key={index}
              style={{
                position: 'absolute',
                left: `${item.x * 100}%`,
                top: `${item.y * 100}%`,
                color: '#d7ff45',
                fontSize: 150,
                fontWeight: 950,
                transform: 'translate(-50%,-50%) rotate(35deg)',
              }}
            >
              ➜
            </div>
          );
        return (
          <div
            key={index}
            style={{
              position: 'absolute',
              left: `${item.x * 100}%`,
              top: `${item.y * 100}%`,
              color: '#d7ff45',
              fontFamily: 'Inter, Arial, sans-serif',
              fontSize: 68,
              fontWeight: 950,
              textTransform: 'uppercase',
              transform: 'translate(-50%,-50%)',
              textShadow: '0 4px 0 #000',
            }}
          >
            {item.text}
          </div>
        );
      })}
    </AbsoluteFill>
  );
}

function DebugOverlay({ edl }: { edl: EditDecisionList }) {
  const frame = useCurrentFrame(),
    { fps } = useVideoConfig();
  return (
    <div
      style={{
        position: 'absolute',
        left: 24,
        bottom: 32,
        color: '#d7ff45',
        background: '#000b',
        padding: 10,
        font: '20px monospace',
      }}
    >
      {edl.cropStrategy} · {(frame / fps).toFixed(2)}s
    </div>
  );
}

export function GameplayShort(props: GameplayShortProps) {
  return (
    <AbsoluteFill style={{ background: '#050607', overflow: 'hidden' }}>
      <GameplayLayer props={props} />
      <Effects edl={props.edl} />
      <HookText edl={props.edl} />
      <CaptionLayer edl={props.edl} />
      {props.debug ? <DebugOverlay edl={props.edl} /> : null}
    </AbsoluteFill>
  );
}
