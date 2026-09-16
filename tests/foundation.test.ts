import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { hashPassword, verifyPassword, newToken, tokenHash } from '../apps/api/src/auth.js';
import { parseConfig } from '../packages/config/src/index.js';
import { assertExtension, uploadInput, expectedPartBytes } from '../packages/shared/src/index.js';
import { LocalStorage } from '../packages/storage/src/index.js';
import { parseProbe, runMedia } from '../packages/video-analysis/src/index.js';
import {
  buildGenericCandidates,
  GenericGameplayDetector,
} from '../packages/video-analysis/src/generic-detector.js';
import { identifyGame } from '../packages/video-analysis/src/game-identification.js';
import {
  candidateRankingSchema,
  MockCandidateRankingProvider,
  OpenAICandidateRankingProvider,
  MockShortPlanningProvider,
  OpenAIShortPlanningProvider,
  shortPlanningSchema,
  transcribeAudioClip,
} from '../packages/ai/src/index.js';
import { selectQualifiedShortCandidates } from '../apps/worker/src/plan-shorts.js';
import {
  cutsWithoutDeadAir,
  editDecisionListSchema,
  validateEditDecisionList,
} from '../packages/remotion/src/public.js';
import {
  CODDetector,
  FCDetector,
  FortniteDetector,
  GTADetector,
  detectorForGame,
} from '../packages/game-detectors/src/index.js';

describe('password and session security', () => {
  it('salts passwords and rejects wrong passwords', async () => {
    const first = await hashPassword('a-test-password-long'),
      second = await hashPassword('a-test-password-long');
    expect(first).not.toEqual(second);
    expect(await verifyPassword('a-test-password-long', first)).toBe(true);
    expect(await verifyPassword('incorrect', first)).toBe(false);
    expect(await verifyPassword('incorrect', 'invalid')).toBe(false);
  });
  it('rejects short passwords', async () => {
    await expect(hashPassword('short')).rejects.toThrow('12');
  });
  it('uses unpredictable session tokens stored as hashes', () => {
    const a = newToken(),
      b = newToken();
    expect(a).not.toBe(b);
    expect(tokenHash(a)).not.toBe(a);
    expect(tokenHash(a)).toHaveLength(64);
  });
});
describe('configuration', () => {
  const env = { DATABASE_URL: 'postgresql://localhost/test', REDIS_URL: 'redis://localhost' };
  it('centralizes defaults', () => {
    const config = parseConfig(env);
    expect(config.TIMEZONE).toBe('Africa/Accra');
    expect(config.UPLOAD_CHUNK_BYTES).toBe(8 * 1024 ** 2);
  });
  it('rejects unsafe production origins', () => {
    expect(() => parseConfig({ ...env, NODE_ENV: 'production' })).toThrow('HTTPS');
  });
  it('does not permit development mock rankings in production', () => {
    expect(() =>
      parseConfig({
        ...env,
        NODE_ENV: 'production',
        APP_URL: 'https://shorts.example.com',
      }),
    ).toThrow('AI_MODE');
  });
  it('requires an S3 bucket', () => {
    expect(() => parseConfig({ ...env, STORAGE_PROVIDER: 's3' })).toThrow('STORAGE_BUCKET');
  });
  it('rejects invalid timezone and limits', () => {
    expect(() => parseConfig({ ...env, TIMEZONE: 'invalid-zone' })).toThrow();
    expect(() => parseConfig({ ...env, WORKER_CONCURRENCY: '0' })).toThrow();
  });
  it('allows transparent heuristic drafts when local OpenAI credentials are absent', () => {
    expect(() => parseConfig({ ...env, AI_MODE: 'openai' })).not.toThrow();
    expect(() =>
      parseConfig({
        ...env,
        AI_MODE: 'openai',
        OPENAI_API_KEY: 'test-key',
        AI_VISION_MODEL: 'test-vision-model',
      }),
    ).not.toThrow();
  });
});
describe('upload contracts', () => {
  const input = {
    filename: 'game.mp4',
    mimeType: 'video/mp4',
    bytes: 2048,
    rightsAcknowledged: true,
  };
  it('requires publishing rights acknowledgment', () => {
    expect(uploadInput.safeParse({ ...input, rightsAcknowledged: false }).success).toBe(false);
  });
  it('rejects path traversal, unsupported MIME and null bytes', () => {
    for (const filename of ['../bad.mp4', 'C:\\bad.mp4', 'bad\0.mp4'])
      expect(uploadInput.safeParse({ ...input, filename }).success).toBe(false);
    expect(uploadInput.safeParse({ ...input, mimeType: 'text/html' }).success).toBe(false);
  });
  it('validates the filename and declared type', () => {
    expect(() => assertExtension('clip.mov', 'video/mp4')).toThrow();
    expect(() => assertExtension('CLIP.MOV', 'video/quicktime')).not.toThrow();
  });
  it('calculates last chunk size and rejects invalid indexes', () => {
    expect(expectedPartBytes(2100, 1024, 2)).toBe(52);
    for (const index of [-1, 0.5, 3, NaN])
      expect(() => expectedPartBytes(2100, 1024, index)).toThrow();
  });
});
describe('storage integrity', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  it('round trips bytes and blocks unsafe paths', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'shorts-unit-'));
    dirs.push(dir);
    const storage = new LocalStorage(dir);
    await storage.put('originals/one.media', Readable.from(Buffer.from([0, 1, 255, 34])));
    const chunks = [];
    for await (const chunk of await storage.read('originals/one.media')) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([0, 1, 255, 34]));
    for (const key of ['../escape.mp4', '/escape.mp4', 'C:\\escape.mp4', 'a/../escape.mp4'])
      expect(() => storage.path(key)).toThrow();
    await storage.remove('originals/one.media');
    await expect(storage.read('originals/one.media')).rejects.toThrow();
  });
  it('never commits a failed stream as an asset', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'shorts-unit-'));
    dirs.push(dir);
    const storage = new LocalStorage(dir);
    async function* broken() {
      yield 'incomplete';
      throw new Error('Connection lost');
    }
    await expect(storage.put('originals/broken.media', Readable.from(broken()))).rejects.toThrow(
      'Connection lost',
    );
    expect(await readdir(resolve(dir, 'originals'))).toEqual([]);
  });
});
describe('actual metadata validation', () => {
  const probe = {
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        width: 1920,
        height: 1080,
        avg_frame_rate: '60000/1001',
      },
    ],
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '123.5' },
  };
  it('extracts metadata without inventing audio', () => {
    const result = parseProbe(probe, 'video/mp4');
    expect(result.duration).toBe(123.5);
    expect(result.hasAudio).toBe(false);
    expect(result.frameRate).toBeCloseTo(59.94, 2);
  });
  it('detects audio presence', () => {
    expect(
      parseProbe(
        { ...probe, streams: [...probe.streams, { codec_type: 'audio', codec_name: 'aac' }] },
        'video/mp4',
      ).audioCodec,
    ).toBe('aac');
  });
  it('rejects a mismatched actual container', () => {
    expect(() => parseProbe(probe, 'video/webm')).toThrow('format');
  });
  it('rejects missing video, bad duration and excessive resolution', () => {
    expect(() => parseProbe({ ...probe, streams: [] }, 'video/mp4')).toThrow();
    expect(() =>
      parseProbe({ ...probe, format: { ...probe.format, duration: 'NaN' } }, 'video/mp4'),
    ).toThrow();
    expect(() =>
      parseProbe({ ...probe, streams: [{ ...probe.streams[0], width: 10000 }] }, 'video/mp4'),
    ).toThrow();
  });
  it('passes arguments without shell interpretation', async () => {
    expect(
      await runMedia(
        process.execPath,
        ['-e', 'process.stdout.write(process.argv[1])', '$(whoami); & echo danger'],
        5000,
      ),
    ).toBe('$(whoami); & echo danger');
  });
  it('terminates timeouts', async () => {
    await expect(
      runMedia(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 100),
    ).rejects.toMatchObject({ code: 'MEDIA_TIMEOUT', permanent: false });
  });
  it('reports missing binaries as retryable', async () => {
    await expect(runMedia('nonexistent-shorts-ffmpeg', [], 1000)).rejects.toMatchObject({
      code: 'MEDIA_TOOL_UNAVAILABLE',
      permanent: false,
    });
  });
});
describe('Phase 2 gameplay analysis', () => {
  it('identifies only explicit filename evidence and otherwise falls back safely', () => {
    expect(identifyGame('ranked-warzone-session.mp4')).toMatchObject({
      game: 'Call of Duty: Warzone',
      method: 'FILENAME',
    });
    expect(identifyGame('family-vacation.mp4')).toMatchObject({
      game: 'Unknown gameplay',
      confidence: 0,
      method: 'GENERIC',
    });
  });
  it('clusters nearby signals into bounded, non-semantic candidates', () => {
    const candidates = buildGenericCandidates(
      [
        { kind: 'MOTION_PEAK', timestamp: 10, value: 0.2 },
        { kind: 'AUDIO_PEAK', timestamp: 11, value: -5 },
        { kind: 'SCENE_CHANGE', timestamp: 40, value: 0.4 },
      ],
      50,
      12,
    );
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.startTime).toBeGreaterThanOrEqual(0);
    expect(candidates[0]?.endTime).toBeLessThanOrEqual(50);
    expect(candidates.every((candidate) => !/kill|goal/i.test(candidate.reason))).toBe(true);
  });
  it('provides a truthful low-score fallback for quiet footage', () => {
    const detector = new GenericGameplayDetector(),
      [candidate] = detector.enrichCandidates(
        detector.scoreEvents(detector.detectEvents([], 20)),
        20,
        1,
      );
    expect(candidate).toMatchObject({ eventTime: 10, signalScore: 10 });
    expect(candidate?.reason).toContain('Fallback');
  });
});

describe('Phase 3 game intelligence', () => {
  const id = '4c15b0ae-c2cf-4d4c-b8c6-ec6f73012345',
    candidate = {
      id,
      startTime: 4,
      eventTime: 8,
      endTime: 14,
      eventType: 'GAMEPLAY_ACTIVITY_SPIKE',
      signalScore: 72,
      signalKinds: ['MOTION_PEAK', 'AUDIO_PEAK'],
      frames: ['data:image/jpeg;base64,AA=='],
    };
  it('selects the four adapters only for confident game identification', () => {
    expect(detectorForGame('EA Sports FC', 0.9)).toBeInstanceOf(FCDetector);
    expect(detectorForGame('Grand Theft Auto VI', 0.9)).toBeInstanceOf(GTADetector);
    expect(detectorForGame('Call of Duty: Warzone', 0.9)).toBeInstanceOf(CODDetector);
    expect(detectorForGame('Fortnite', 0.9)).toBeInstanceOf(FortniteDetector);
    expect(detectorForGame('Fortnite', 0.4)).toBeInstanceOf(GenericGameplayDetector);
  });
  it('keeps adapter labels observational until sampled frames are interpreted', () => {
    const [result] = new CODDetector().enrichCandidates(
      new CODDetector().scoreEvents(
        new CODDetector().detectEvents(
          [
            { kind: 'MOTION_PEAK', timestamp: 10, value: 0.4 },
            { kind: 'AUDIO_PEAK', timestamp: 10.2, value: -3 },
          ],
          30,
        ),
      ),
      30,
      1,
    );
    expect(result?.eventType).toBe('COD_FIREFIGHT_OR_REACTION_SEQUENCE');
    expect(result?.reason).toContain('required before naming a kill');
  });
  it('returns bounded, explicitly labeled deterministic rankings in mock mode', async () => {
    const result = await new MockCandidateRankingProvider().rank({
      inputHash: 'hash',
      ownerHash: 'owner-hash',
      detectorProfile: 'generic-gameplay-v1',
      currentGame: 'Unknown gameplay',
      currentGameConfidence: 0,
      candidates: [candidate],
    });
    expect(result.provider).toBe('mock');
    expect(result.output.rankings[0]).toMatchObject({
      candidateId: id,
      confidence: 35,
      eventType: 'GAMEPLAY_ACTIVITY_SPIKE',
    });
    expect(result.output.rankings[0]?.reason).toContain('no semantic event claim');
    expect(candidateRankingSchema.safeParse(result.output).success).toBe(true);
  });
  it('uses the Responses API with strict structured output and high-detail adaptive frames', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const config = parseConfig({
        DATABASE_URL: 'postgresql://localhost/test',
        REDIS_URL: 'redis://localhost',
        AI_MODE: 'openai',
        OPENAI_API_KEY: 'test-key',
        AI_VISION_MODEL: 'test-vision-model',
        AI_INPUT_USD_PER_1M: '1',
        AI_OUTPUT_USD_PER_1M: '2',
      }),
      ranking = {
        candidateId: id,
        eventType: 'VISIBLE_GAMEPLAY_EVENT',
        eventImportance: 70,
        excitement: 80,
        surprise: 60,
        skill: 75,
        humor: 20,
        tension: 65,
        emotionalReaction: 55,
        chaos: 64,
        reactionStrength: 55,
        visualClarity: 90,
        storyCompleteness: 84,
        contextIndependence: 70,
        hookPotential: 85,
        retentionPotential: 80,
        sharePotential: 72,
        commentPotential: 69,
        novelty: 50,
        editability: 88,
        confidence: 91,
        highlightScore: 81,
        shortWorthinessScore: 83,
        decision: 'SELECTED',
        rejectionReason: null,
        eventStart: 10,
        keyMoment: 16,
        payoffEnd: 22,
        recommendedStart: 8,
        recommendedEnd: 24,
        durationReason: 'The complete setup and payoff fit in this interval.',
        eventSummary: 'A visible combat sequence builds to a clear payoff.',
        reason: 'The visible sequence has a clear setup and payoff.',
      },
      provider = new OpenAICandidateRankingProvider(config, async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              gameIdentification: { game: 'Fortnite', edition: null, confidence: 92 },
              rankings: [ranking],
            }),
            usage: { input_tokens: 1000, output_tokens: 500 },
          }),
          { status: 200 },
        );
      });
    const result = await provider.rank({
      inputHash: 'input-hash',
      ownerHash: 'safe-owner-hash',
      detectorProfile: 'fortnite-v1',
      currentGame: 'Fortnite',
      currentGameConfidence: 0.8,
      candidates: [candidate],
    });
    expect(requestBody).toMatchObject({
      model: 'test-vision-model',
      store: false,
      safety_identifier: 'safe-owner-hash',
      prompt_cache_key: 'input-hash',
      text: { format: { type: 'json_schema', strict: true } },
    });
    expect(JSON.stringify(requestBody)).toContain('"detail":"high"');
    expect(result.output.rankings[0]?.highlightScore).toBe(81);
    expect(result.estimatedCostUsd).toBe(0.002);
  });
  it('rejects scores outside the documented zero-to-one-hundred range', () => {
    expect(
      candidateRankingSchema.safeParse({
        gameIdentification: { game: 'Unknown gameplay', edition: null, confidence: 0 },
        rankings: [
          {
            candidateId: id,
            eventType: 'ACTIVITY',
            ...Object.fromEntries(
              [
                'eventImportance',
                'excitement',
                'surprise',
                'skill',
                'humor',
                'tension',
                'emotionalReaction',
                'visualClarity',
                'contextIndependence',
                'hookPotential',
                'retentionPotential',
                'sharePotential',
                'novelty',
                'editability',
                'confidence',
                'highlightScore',
              ].map((key) => [key, key === 'highlightScore' ? 101 : 50]),
            ),
            reason: 'Out of bounds.',
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('Phase 4 short creation', () => {
  const planningInput = {
    inputHash: 'plan-hash',
    ownerHash: 'owner-hash',
    game: 'Fortnite',
    eventType: 'FINAL_CIRCLE_WIN',
    sourceDuration: 60,
    startTime: 20,
    eventTime: 26,
    endTime: 30,
    reason: 'Visible end-game state and outcome.',
    highlightScore: 88,
    confidence: 91,
    contextIndependence: 80,
    visualClarity: 90,
    preferredHashtags: ['#creator'],
    bannedHashtags: ['#spoiler'],
    transcript: 'I cannot believe that worked',
    editorialSignals: {
      excitement: 88,
      surprise: 84,
      skill: 76,
      humor: 20,
      tension: 72,
      emotionalReaction: 81,
      hookPotential: 90,
      retentionPotential: 86,
      sharePotential: 79,
      novelty: 74,
      editability: 92,
    },
  };
  it('creates three distinct, valid and truthful concepts in deterministic mode', async () => {
    const result = await new MockShortPlanningProvider().plan(planningInput);
    expect(result.output.concepts.map((concept) => concept.key)).toEqual([
      'ACTION_FIRST',
      'TENSION_FIRST',
      'CONTEXT_FIRST',
    ]);
    expect(
      result.output.concepts.every((concept) => concept.hook.includes('FINAL CIRCLE WIN')),
    ).toBe(true);
    expect(result.output.concepts.every((concept) => !concept.hashtags.includes('#spoiler'))).toBe(
      true,
    );
    expect(result.output.concepts.every((concept) => concept.cropStrategy === 'SMART_CROP')).toBe(
      true,
    );
    expect(result.output.concepts.every((concept) => concept.captionBeats.length === 1)).toBe(true);
    expect(
      result.output.concepts.every((concept) => !concept.titleCandidates[0]!.includes('_')),
    ).toBe(true);
    expect(shortPlanningSchema.safeParse(result.output).success).toBe(true);
  });
  it('removes only interior measured dead air and preserves setup/payoff', () => {
    expect(cutsWithoutDeadAir(10, 20, [{ timestamp: 13, duration: 2 }])).toEqual([
      { sourceStart: 10, sourceEnd: 13, outputStart: 0, speed: 1 },
      { sourceStart: 15, sourceEnd: 20, outputStart: 3, speed: 1 },
    ]);
    expect(cutsWithoutDeadAir(10, 20, [{ timestamp: 10, duration: 3 }])).toHaveLength(1);
  });
  it('uses ranked evidence to determine yield instead of always creating three Shorts', () => {
    const ranked = Array.from({ length: 12 }, (_, index) => ({
      id: String(index),
      startTime: index * 20,
      eventTime: index * 20 + 8,
      endTime: index * 20 + 14,
      score: {
        highlightScore: index < 10 ? 88 - index : 42,
        confidence: 80,
        editability: 80,
        visualClarity: 80,
        contextIndependence: 80,
      },
    }));
    expect(selectQualifiedShortCandidates(ranked, 24)).toHaveLength(10);
    expect(selectQualifiedShortCandidates(ranked, 6)).toHaveLength(6);
    expect(
      selectQualifiedShortCandidates(
        ranked.map((candidate) => ({
          ...candidate,
          score: { ...candidate.score, highlightScore: 30 },
        })),
        24,
      ),
    ).toHaveLength(0);
  });
  it('parses timestamped speech for selective subtitle generation', async () => {
    const config = parseConfig({
      DATABASE_URL: 'postgresql://localhost/test',
      REDIS_URL: 'redis://localhost',
      AI_MODE: 'openai',
      OPENAI_API_KEY: 'test-key',
      AI_VISION_MODEL: 'vision',
    });
    const result = await transcribeAudioClip(config, new Uint8Array([1, 2, 3]), (async (
      _url,
      init,
    ) => {
      expect(init?.body).toBeInstanceOf(FormData);
      return new Response(
        JSON.stringify({
          text: 'No way that worked',
          words: [
            { word: 'No', start: 0, end: 0.2 },
            { word: 'way', start: 0.21, end: 0.4 },
          ],
        }),
      );
    }) as typeof fetch);
    expect(result.words).toHaveLength(2);
  });
  it('rejects late hooks, unsafe tracking, invalid captions and timelines over 60 seconds', () => {
    const valid = {
      schemaVersion: 1,
      clipStart: 10,
      clipEnd: 20,
      outputDuration: 10,
      cropStrategy: 'BACKGROUND_BLUR',
      trackedSubject: [],
      hook: { text: 'VISIBLE EVENT', start: 0, end: 2, position: 'TOP' },
      cuts: [{ sourceStart: 10, sourceEnd: 20, outputStart: 0, speed: 1 }],
      zooms: [],
      freezeFrames: [],
      replay: null,
      captions: [],
      overlays: [],
      audioInstructions: { preserveOriginal: true, normalize: true, gainDb: 0, ducking: [] },
      title: 'VISIBLE EVENT',
      description: '',
      hashtags: ['#gaming'],
    };
    expect(validateEditDecisionList(valid).outputDuration).toBe(10);
    expect(
      editDecisionListSchema.safeParse({ ...valid, hook: { ...valid.hook, start: 1 } }).success,
    ).toBe(false);
    expect(editDecisionListSchema.safeParse({ ...valid, outputDuration: 61 }).success).toBe(false);
    expect(
      editDecisionListSchema.safeParse({ ...valid, trackedSubject: [{ time: 1, x: 0.5, y: 0.5 }] })
        .success,
    ).toBe(false);
    expect(
      editDecisionListSchema.safeParse({
        ...valid,
        captions: [{ text: 'x'.repeat(81), start: 0, end: 1, emphasis: [], position: 'BOTTOM' }],
      }).success,
    ).toBe(false);
  });
  it('uses strict Responses API output for short planning without supplying invented transcript', async () => {
    let body: Record<string, unknown> | undefined;
    const config = parseConfig({
      DATABASE_URL: 'postgresql://localhost/test',
      REDIS_URL: 'redis://localhost',
      AI_MODE: 'openai',
      OPENAI_API_KEY: 'test-key',
      AI_VISION_MODEL: 'vision',
      AI_REASONING_MODEL: 'reasoning',
    });
    const mockOutput = (await new MockShortPlanningProvider().plan(planningInput)).output;
    const provider = new OpenAIShortPlanningProvider(config, async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify(mockOutput),
          usage: { input_tokens: 20, output_tokens: 30 },
        }),
        { status: 200 },
      );
    });
    const result = await provider.plan(planningInput);
    expect(body).toMatchObject({
      model: 'reasoning',
      store: false,
      safety_identifier: 'owner-hash',
      prompt_cache_key: 'plan-hash',
      text: { format: { type: 'json_schema', strict: true } },
    });
    expect(JSON.stringify(body)).toContain('never fake speech');
    expect(result.output.selectedKey).toBe(mockOutput.selectedKey);
  });
});
