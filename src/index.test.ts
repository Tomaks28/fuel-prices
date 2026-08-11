/**
 * The entry point is the package contract: anything that disappears from here is
 * a breaking change, and anything that leaks in becomes one to remove.
 */

import { afterEach, describe, expect, it } from '@jest/globals';

import * as sdk from './index.js';

afterEach(() => {
  sdk.resetFuelPricesClient();
});

describe('the public surface', () => {
  it('exports exactly what it means to', () => {
    expect(Object.keys(sdk).sort()).toEqual([
      'FUEL_TYPES',
      'FuelPricesClient',
      'FuelPricesError',
      'VERSION',
      'getFuelPricesClient',
      'resetFuelPricesClient',
    ]);
  });

  it('exports a version string', () => {
    expect(typeof sdk.VERSION).toBe('string');
  });

  it('exports the six fuels of the dataset, frozen at build time', () => {
    expect(sdk.FUEL_TYPES).toEqual(['gazole', 'sp95', 'sp98', 'e10', 'e85', 'gplc']);
  });

  it('exports an error class that survives an instanceof check', () => {
    const error = new sdk.FuelPricesError('boom', { code: 'network' });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(sdk.FuelPricesError);
    expect(error.name).toBe('FuelPricesError');
    expect(error.code).toBe('network');
  });

  it('wires the accessors to the same shared client', () => {
    expect(sdk.getFuelPricesClient()).toBe(sdk.FuelPricesClient.getInstance());
  });

  it('reaches the API through the client it exports', async () => {
    const client = sdk.getFuelPricesClient({
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify([{ id: 1, ville: 'Rennes', gazole_prix: 1.9 }]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
    });

    const stations = await client.getStationsByCity('rennes');

    expect(stations).toHaveLength(1);
    expect(stations[0]?.prices.gazole?.price).toBe(1.9);
  });
});
