import { describe, expect, it } from '@jest/globals';

import { BrandIndex, coveringBoxes, tileKey, type BrandPoint } from './brand-index.js';

/** Saint-Malo, where the fixtures of the other suites live. */
const STATION = { latitude: 48.65797, longitude: -1.97092 };

/** Roughly `meters` north of `STATION`, which is enough to test a radius. */
function north(meters: number): { latitude: number; longitude: number } {
  return { latitude: STATION.latitude + meters / 111_320, longitude: STATION.longitude };
}

function at(location: { latitude: number; longitude: number }, brand: string): BrandPoint {
  return { location, brand };
}

describe('the nearest brand', () => {
  it('finds a point sitting on the station', () => {
    const index = new BrandIndex([at(STATION, 'TotalEnergies')]);

    expect(index.nearest(STATION, 150)).toBe('TotalEnergies');
  });

  it('finds one a few tens of metres off, which is the normal case', () => {
    const index = new BrandIndex([at(north(60), 'Avia')]);

    expect(index.nearest(STATION, 150)).toBe('Avia');
  });

  it('ignores a point beyond the radius', () => {
    const index = new BrandIndex([at(north(400), 'Avia')]);

    expect(index.nearest(STATION, 150)).toBeNull();
  });

  it('prefers the closest of two candidates, whatever order they came in', () => {
    const far = at(north(120), 'Esso');
    const near = at(north(20), 'Système U');

    expect(new BrandIndex([far, near]).nearest(STATION, 150)).toBe('Système U');
    expect(new BrandIndex([near, far]).nearest(STATION, 150)).toBe('Système U');
  });

  it('reaches across a cell boundary', () => {
    // 0.02° cells: a station just below a boundary and a node just above it land
    // in different cells, and a lookup that only read its own would miss it.
    const onBoundary = { latitude: 48.019_99, longitude: 2.019_99 };
    const acrossBoth = { latitude: 48.020_05, longitude: 2.020_05 };
    const index = new BrandIndex([at(acrossBoth, 'BP')]);

    expect(index.nearest(onBoundary, 150)).toBe('BP');
  });

  it('answers null on an empty cloud', () => {
    expect(new BrandIndex([]).nearest(STATION, 150)).toBeNull();
  });
});

describe('the boxes it covers stations with', () => {
  it('wraps a single cluster in one padded box', () => {
    const [box, ...rest] = coveringBoxes([STATION], 150);

    expect(rest).toEqual([]);
    expect(box?.south).toBeLessThan(STATION.latitude);
    expect(box?.north).toBeGreaterThan(STATION.latitude);
    expect(box?.west).toBeLessThan(STATION.longitude);
    expect(box?.east).toBeGreaterThan(STATION.longitude);
  });

  it('gives every distant cluster its own box', () => {
    const boxes = coveringBoxes(
      [
        { latitude: 48.65, longitude: -1.97 }, // Saint-Malo
        { latitude: 43.29, longitude: 5.37 }, // Marseille
        { latitude: 16.24, longitude: -61.53 }, // Guadeloupe
        { latitude: -20.88, longitude: 55.45 }, // La Réunion
      ],
      150,
    );

    // One box around the four would span a third of the planet; Overpass would
    // be asked for every station between the Caribbean and the Indian Ocean.
    expect(boxes).toHaveLength(4);
    expect(boxes.some((box) => box.south < -20 && box.east > 55)).toBe(true);
    expect(boxes.some((box) => box.west < -61 && box.north < 17)).toBe(true);
  });

  it('groups what shares a tile into that tile’s own extent', () => {
    const boxes = coveringBoxes(
      [
        { latitude: 48.11, longitude: -1.68 }, // Rennes
        { latitude: 48.65, longitude: -1.97 }, // Saint-Malo, same 2° tile
      ],
      150,
    );

    expect(boxes).toHaveLength(1);
    expect(boxes[0]?.south).toBeCloseTo(48.11, 2);
    expect(boxes[0]?.north).toBeCloseTo(48.65, 2);
  });

  it('shrinks a tile to its stations rather than querying the whole square', () => {
    const [box] = coveringBoxes([{ latitude: 48.11, longitude: -1.68 }], 150);

    // The tile spans 48-50° by -2-0°; the box is a few hundred metres wide.
    expect((box?.north ?? 0) - (box?.south ?? 0)).toBeLessThan(0.01);
  });

  it('is ordered, so the same stations always build the same query', () => {
    const points = [
      { latitude: 48.65, longitude: -1.97 },
      { latitude: 16.24, longitude: -61.53 },
    ];

    expect(coveringBoxes(points, 150)).toEqual(coveringBoxes([...points].reverse(), 150));
  });

  it('never leaves the coordinate system', () => {
    const [box] = coveringBoxes([{ latitude: 90, longitude: 180 }], 5_000);

    expect(box?.north).toBe(90);
    expect(box?.east).toBe(180);
  });

  it('returns nothing for nothing', () => {
    expect(coveringBoxes([], 150)).toEqual([]);
  });
});

describe('the tile a point belongs to', () => {
  it('is shared by everything in the same square', () => {
    expect(tileKey({ latitude: 48.11, longitude: -1.68 })).toBe(
      tileKey({ latitude: 48.65, longitude: -1.97 }),
    );
  });

  it('differs across the square', () => {
    expect(tileKey({ latitude: 48.65, longitude: -1.97 })).not.toBe(
      tileKey({ latitude: 43.29, longitude: 5.37 }),
    );
  });
});
