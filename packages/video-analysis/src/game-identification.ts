export const supportedGames = [
  'Unknown gameplay',
  'Grand Theft Auto V',
  'Grand Theft Auto VI',
  'EA Sports FC',
  'FIFA',
  'Call of Duty',
  'Call of Duty: Warzone',
  'Fortnite',
  'Valorant',
  'Apex Legends',
  'Minecraft',
  'Rocket League',
  'NBA 2K',
] as const;

export type GameDetectionResult = {
  game: (typeof supportedGames)[number];
  edition: string | null;
  confidence: number;
  detectorProfile: 'generic-gameplay-v1';
  method: 'FILENAME' | 'GENERIC';
  evidence: { filenameMatch?: string; limitation: string };
};

export function identifyGame(filename: string): GameDetectionResult {
  const normalized = filename.toLowerCase().replace(/[-_.]+/g, ' '),
    matches: Array<[RegExp, GameDetectionResult['game'], string | null]> = [
      [/\b(gta\s*6|gta\s*vi|grand theft auto\s*vi)\b/, 'Grand Theft Auto VI', 'VI'],
      [/\b(gta\s*5|gta\s*v|grand theft auto\s*v)\b/, 'Grand Theft Auto V', 'V'],
      [/\b(warzone)\b/, 'Call of Duty: Warzone', 'Warzone'],
      [/\b(call of duty|cod)\b/, 'Call of Duty', null],
      [/\b(ea sports fc|fc\s*2[4-9])\b/, 'EA Sports FC', null],
      [/\bfifa\b/, 'FIFA', null],
      [/\bfortnite\b/, 'Fortnite', null],
      [/\bvalorant\b/, 'Valorant', null],
      [/\bapex( legends)?\b/, 'Apex Legends', null],
      [/\bminecraft\b/, 'Minecraft', null],
      [/\brocket league\b/, 'Rocket League', null],
      [/\bnba\s*2k\b/, 'NBA 2K', null],
    ];
  const match = matches.find(([pattern]) => pattern.test(normalized));
  if (!match)
    return {
      game: 'Unknown gameplay',
      edition: null,
      confidence: 0,
      detectorProfile: 'generic-gameplay-v1',
      method: 'GENERIC',
      evidence: {
        limitation: 'Phase 2 uses conservative filename evidence and allows a user override.',
      },
    };
  return {
    game: match[1],
    edition: match[2],
    confidence: 0.82,
    detectorProfile: 'generic-gameplay-v1',
    method: 'FILENAME',
    evidence: {
      filenameMatch: normalized.match(match[0])?.[0] ?? match[1],
      limitation: 'Filename inference is provisional until visual game identification is added.',
    },
  };
}
