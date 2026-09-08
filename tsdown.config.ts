import { defineConfig, type UserConfig } from 'tsdown'

// Host half: node bundle, every @deepseek-ai seam externalized (resolved from
// the dsh installation at runtime).
export const hostConfig: UserConfig = {
  name: 'dsh-mobile-gateway',
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  dts: true,
  clean: true,
  outExtensions: () => ({ js: '.js' }),
  external: [/^@deepseek-ai\//],
}

/**
 * Browser half — the classic-script factory-registration artifact the
 * dsh-client-modules loader expects: `window.__ModuleLoader__.load({id,
 * factory})`, with externals resolved through the injected synchronous
 * `require` from the shell's frozen module table (react and friends). The
 * recipe mirrors the dsh-web-ui shared preset verified against the rc.2 dist.
 */
export const clientConfig: UserConfig = {
  name: 'dsh-mobile-gateway/client',
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  // dts must stay off: the banner/footer wrapper would land in the .d.cts and
  // break parsing; the ./client export ships runtime only.
  dts: false,
  sourcemap: true,
  clean: false,
  external: [
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
  ],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-mobile-gateway", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([hostConfig, clientConfig])
