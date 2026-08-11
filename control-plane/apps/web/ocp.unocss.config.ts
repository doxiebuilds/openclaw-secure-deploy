/**
 * OpenClaw Control Plane — UnoCSS theme bridge.
 * Maps short utility names onto --ocp-* CSS custom properties defined in
 * src/styles/themes/palette.css and shell-tokens.css.
 */
import { defineConfig, presetMini, presetWind3, transformerDirectives, transformerVariantGroup } from 'unocss';
import { presetExtra } from 'unocss-preset-extra';

const ink = {
  ink: 'var(--ocp-ink)',
  'ink-2': 'var(--ocp-ink-2)',
  'ink-3': 'var(--ocp-ink-3)',
  'ink-disabled': 'var(--ocp-ink-disabled)',
  'ink-on': 'var(--ocp-ink-on)',
};

const surfaces = {
  canvas: 'var(--ocp-canvas)',
  raised: 'var(--ocp-raised)',
  panel: 'var(--ocp-panel)',
  recess: 'var(--ocp-recess)',
  well: 'var(--ocp-well)',
  ash: 'var(--ocp-ash)',
  steel: 'var(--ocp-steel)',
  slate: 'var(--ocp-slate)',
  charcoal: 'var(--ocp-charcoal)',
  void: 'var(--ocp-void)',
  hover: 'var(--ocp-hover)',
  press: 'var(--ocp-press)',
};

const edges = {
  edge: 'var(--ocp-edge)',
  'edge-soft': 'var(--ocp-edge-soft)',
};

const status = {
  accent: 'var(--ocp-accent)',
  ok: 'var(--ocp-ok)',
  warn: 'var(--ocp-warn)',
  bad: 'var(--ocp-bad)',
  info: 'var(--ocp-info)',
};

const specialized = {
  'bubble-user': 'var(--ocp-bubble-user)',
  'bubble-hint': 'var(--ocp-bubble-hint)',
  chip: 'var(--ocp-chip)',
};

export default defineConfig({
  presets: [presetMini(), presetExtra(), presetWind3()],
  transformers: [transformerVariantGroup(), transformerDirectives({ enforce: 'pre' })],
  content: {
    pipeline: {
      include: [/\.[jt]sx?($|\?)/, /\.css($|\?)/],
      exclude: [/[\\/]node_modules[\\/]/, /\.html($|\?)/],
    },
  },
  rules: [
    ['bg-popup', { 'background-color': 'var(--ocp-raised)' }],
  ],
  preflights: [
    {
      getCSS: () => `
        * { color: inherit; }
        *, ::before, ::after {
          border-width: 0;
          border-style: solid;
          border-color: transparent;
        }
      `,
    },
  ],
  shortcuts: {
    'ocp-center': 'flex items-center justify-center',
  },
  theme: {
    colors: {
      ...ink,
      ...surfaces,
      ...edges,
      ...status,
      ...specialized,
    },
    fontFamily: {
      mono: 'var(--ocp-font-mono)',
    },
  },
});
