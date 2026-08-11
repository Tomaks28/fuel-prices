import { describe, expect, it } from '@jest/globals';

import { assertGeoPoint, assertRadius, distanceMeters } from './geo.js';

const SAINT_MALO = { latitude: 48.64878, longitude: -2.02585 };
const DINARD = { latitude: 48.63194, longitude: -2.05611 };
const PARIS = { latitude: 48.853, longitude: 2.3499 };
const LYON = { latitude: 45.764, longitude: 4.8357 };

describe('distanceMeters', () => {
  it('measures a short hop across an estuary', () => {
    // Cross-checked against a haversine reference implementation.
    expect(distanceMeters(SAINT_MALO, DINARD)).toBeCloseTo(2906.848, 2);
  });

  it('measures a country-scale distance', () => {
    expect(distanceMeters(PARIS, LYON)).toBeCloseTo(391234.011, 1);
  });

  it('is zero for one and the same point', () => {
    expect(distanceMeters(PARIS, PARIS)).toBe(0);
  });

  it('is symmetric', () => {
    expect(distanceMeters(PARIS, LYON)).toBeCloseTo(distanceMeters(LYON, PARIS), 6);
  });

  it('gives one degree the same length along a meridian and along the equator', () => {
    const alongEquator = distanceMeters(
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 1 },
    );
    const alongMeridian = distanceMeters(
      { latitude: 0, longitude: 0 },
      { latitude: 1, longitude: 0 },
    );

    expect(alongEquator).toBeCloseTo(111195.08, 1);
    expect(alongMeridian).toBeCloseTo(alongEquator, 6);
  });

  it('shortens a degree of longitude as latitude rises', () => {
    const atEquator = distanceMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 });
    const inBrittany = distanceMeters(
      { latitude: 48.65, longitude: 0 },
      { latitude: 48.65, longitude: 1 },
    );

    expect(inBrittany).toBeLessThan(atEquator);
    expect(inBrittany / atEquator).toBeCloseTo(Math.cos((48.65 * Math.PI) / 180), 3);
  });

  it('takes the short way round the antimeridian', () => {
    const across = distanceMeters(
      { latitude: 0, longitude: 179.995 },
      { latitude: 0, longitude: -179.995 },
    );

    expect(across).toBeCloseTo(1111.951, 2);
  });

  it('handles antipodes without drifting past half the globe', () => {
    const poleToPole = distanceMeters(
      { latitude: 90, longitude: 0 },
      { latitude: -90, longitude: 0 },
    );

    expect(poleToPole).toBeCloseTo(20015114.442, 1);
    expect(Number.isNaN(poleToPole)).toBe(false);
  });

  it('handles the southern and western hemispheres', () => {
    const sydney = { latitude: -33.8688, longitude: 151.2093 };
    const santiago = { latitude: -33.4489, longitude: -70.6693 };

    // Both cities sit near 33°S, on either side of the antimeridian.
    expect(distanceMeters(sydney, santiago) / 1000).toBeCloseTo(11346.731, 2);
  });
});

describe('assertGeoPoint', () => {
  it('accepts the corners of the coordinate space', () => {
    expect(() => {
      assertGeoPoint({ latitude: 90, longitude: 180 }, 'center');
      assertGeoPoint({ latitude: -90, longitude: -180 }, 'center');
      assertGeoPoint({ latitude: 0, longitude: 0 }, 'center');
    }).not.toThrow();
  });

  it.each([
    ['latitude above the pole', { latitude: 90.1, longitude: 0 }, 'center.latitude'],
    ['latitude below the pole', { latitude: -91, longitude: 0 }, 'center.latitude'],
    ['longitude past the antimeridian', { latitude: 0, longitude: 180.5 }, 'center.longitude'],
    ['longitude below the antimeridian', { latitude: 0, longitude: -181 }, 'center.longitude'],
  ])('rejects a %s', (_label, point, mentioned) => {
    expect(() => {
      assertGeoPoint(point, 'center');
    }).toThrow(expect.objectContaining({ code: 'invalid_argument' }));

    try {
      assertGeoPoint(point, 'center');
    } catch (error) {
      expect((error as Error).message).toContain(mentioned);
    }
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('rejects %p as a coordinate', (value) => {
    expect(() => {
      assertGeoPoint({ latitude: value, longitude: 0 }, 'center');
    }).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
    expect(() => {
      assertGeoPoint({ latitude: 0, longitude: value }, 'center');
    }).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
  });

  it('names the argument it is unhappy about', () => {
    expect(() => {
      assertGeoPoint({ latitude: 200, longitude: 0 }, 'somewhere');
    }).toThrow(/somewhere\.latitude/);
  });
});

describe('assertRadius', () => {
  it('accepts a radius of zero and up', () => {
    expect(() => {
      assertRadius(0, 'radiusMeters');
      assertRadius(5_000, 'radiusMeters');
      assertRadius(20_000_000, 'radiusMeters');
    }).not.toThrow();
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects %p', (value) => {
    expect(() => {
      assertRadius(value, 'radiusMeters');
    }).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
  });
});
