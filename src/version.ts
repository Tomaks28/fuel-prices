declare const __PKG_VERSION__: string;

/** Version of the published package, replaced at build time by the bundler. */
export const VERSION: string = typeof __PKG_VERSION__ === 'string' ? __PKG_VERSION__ : '0.0.0';
