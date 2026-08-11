import { describe, expect, it } from '@jest/globals';

import {
  centreOf,
  defaultAnswers,
  parseAge,
  parseFuels,
  parsePlace,
  promptForAnswers,
  PROMPT_DEFAULTS,
  type Ask,
} from './cli-prompts.js';

/** Replays `answers` in order, and records the questions it was asked. */
function scripted(answers: string[]): { ask: Ask; questions: string[] } {
  const questions: string[] = [];
  let index = 0;

  return {
    questions,
    ask: (question) => {
      questions.push(question);
      return Promise.resolve(answers[index++] ?? '');
    },
  };
}

/** Presses Enter through the whole flow. */
const ENTER_THROUGHOUT = (): { ask: Ask; questions: string[] } => scripted([]);

describe('promptForAnswers', () => {
  it('falls back to Paris and 20 km when every answer is empty', async () => {
    const answers = await promptForAnswers(ENTER_THROUGHOUT().ask);

    expect(answers).toEqual(defaultAnswers());
    expect(answers.place).toBe('Paris');
    expect(answers.radiusMeters).toBe(20_000);
  });

  it('shows each default inside the question, so Enter is an informed choice', async () => {
    const { ask, questions } = ENTER_THROUGHOUT();
    await promptForAnswers(ask);

    expect(questions[0]).toContain('[Paris]');
    expect(questions[1]).toContain('[20000]');
    expect(questions.join('\n')).toContain('[.cache/fuel-prices.json]');
  });

  it('asks the eight questions in a fixed order', async () => {
    const { ask, questions } = ENTER_THROUGHOUT();
    await promptForAnswers(ask);

    const asked = [
      'Where?',
      'Radius in metres',
      'Fuel(s)',
      'open right now?',
      'Ignore quotes older than',
      'Sort by',
      'How many results',
      'Cache file',
    ];

    expect(questions).toHaveLength(asked.length);
    asked.forEach((label, index) => {
      expect(questions[index]).toContain(label);
    });
  });

  it('takes the answers it is given', async () => {
    const { ask } = scripted([
      '48.11,-1.67',
      '5000',
      'gazole, e85',
      'yes',
      '12h',
      'price',
      '3',
      '/tmp/snapshot.json',
    ]);

    expect(await promptForAnswers(ask)).toEqual({
      place: '48.11,-1.67',
      radiusMeters: 5_000,
      fuels: ['gazole', 'e85'],
      openNow: true,
      maxPriceAge: 12 * 60 * 60 * 1000,
      sort: 'price',
      limit: 3,
      cachePath: '/tmp/snapshot.json',
    });
  });

  it('mixes answers and defaults freely', async () => {
    const { ask } = scripted(['Lyon', '', '', '', 'none', '', '5']);
    const answers = await promptForAnswers(ask);

    expect(answers).toMatchObject({
      place: 'Lyon',
      radiusMeters: PROMPT_DEFAULTS.radiusMeters,
      fuels: [],
      maxPriceAge: undefined,
      sort: 'distance',
      limit: 5,
      cachePath: PROMPT_DEFAULTS.cachePath,
    });
  });

  it('turns the cache off on request', async () => {
    const { ask } = scripted(['', '', '', '', '', '', '', 'none']);

    expect((await promptForAnswers(ask)).cachePath).toBeUndefined();
  });

  it.each([
    ['a radius that is not a number', ['', 'far']],
    ['a negative radius', ['', '-1']],
    ['an unknown fuel', ['', '', 'diesel']],
    ['an answer that is neither yes nor no', ['', '', '', 'maybe']],
    ['an unreadable age', ['', '', '', '', 'a fortnight']],
    ['an unknown sort', ['', '', '', '', '', 'cheapest']],
  ])('rejects %s', async (_label, answers) => {
    await expect(promptForAnswers(scripted(answers).ask)).rejects.toMatchObject({
      name: 'FuelPricesError',
      code: 'invalid_argument',
    });
  });

  it('accepts yes and no in French too', async () => {
    expect((await promptForAnswers(scripted(['', '', '', 'oui']).ask)).openNow).toBe(true);
    expect((await promptForAnswers(scripted(['', '', '', 'non']).ask)).openNow).toBe(false);
  });
});

describe('parsePlace', () => {
  it.each([
    ['48.8566,2.3522', { latitude: 48.8566, longitude: 2.3522 }],
    ['  48.11 , -1.67 ', { latitude: 48.11, longitude: -1.67 }],
    ['48.11;-1.67', { latitude: 48.11, longitude: -1.67 }],
    ['-33.86,151.2', { latitude: -33.86, longitude: 151.2 }],
    ['48,2', { latitude: 48, longitude: 2 }],
  ])('reads %j as a point', (raw, expected) => {
    expect(parsePlace(raw)).toEqual(expected);
  });

  it.each(['Paris', 'Saint-Malo', '', 'Rennes 35000', '48.11', '48.11,'])(
    'treats %j as a city name',
    (raw) => {
      expect(parsePlace(raw)).toBeNull();
    },
  );
});

describe('parseAge', () => {
  it.each([
    ['7d', 7 * 86_400_000],
    ['12h', 12 * 3_600_000],
    ['90m', 90 * 60_000],
    ['30s', 30_000],
    ['1.5d', 1.5 * 86_400_000],
    ['5000', 5000],
    ['  7D  ', 7 * 86_400_000],
  ])('reads %j', (raw, expected) => {
    expect(parseAge(raw)).toBe(expected);
  });

  it.each(['none', 'NONE', 'off', '-'])('reads %j as no limit', (raw) => {
    expect(parseAge(raw)).toBeUndefined();
  });

  it.each(['a week', '7 days', '-1d', ''])('rejects %j', (raw) => {
    expect(() => parseAge(raw)).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
  });
});

describe('parseFuels', () => {
  it('reads a list, trimming and lowercasing', () => {
    expect(parseFuels(' Gazole , E85 ')).toEqual(['gazole', 'e85']);
    expect(parseFuels('GPLC')).toEqual(['gplc']);
  });

  it.each(['any', '', '   ', 'none'])('reads %j as no constraint', (raw) => {
    expect(parseFuels(raw)).toEqual([]);
  });

  it('rejects a fuel the dataset does not carry', () => {
    expect(() => parseFuels('diesel')).toThrow(
      expect.objectContaining({ code: 'invalid_argument' }),
    );
    expect(() => parseFuels('gazole,diesel')).toThrow(/diesel/);
  });
});

describe('centreOf', () => {
  it('averages the points', () => {
    expect(
      centreOf([
        { latitude: 48, longitude: 2 },
        { latitude: 50, longitude: 4 },
      ]),
    ).toEqual({ latitude: 49, longitude: 3 });
  });

  it('returns the point itself for a single station', () => {
    expect(centreOf([{ latitude: 48.11, longitude: -1.67 }])).toEqual({
      latitude: 48.11,
      longitude: -1.67,
    });
  });

  it('has no centre for an empty set', () => {
    expect(centreOf([])).toBeNull();
  });
});
