import classNames from 'classnames';

/**
 * The product mark, in the one place that owns it.
 *
 * Emoji rather than drawn paths: color emoji ignores `currentColor`, so the
 * glyph itself does not flip with the theme — the charcoal chip behind it is
 * what carries that. The explicit emoji font stack keeps Linux and Windows
 * from falling back to a monochrome outline.
 */
export function Logo({ className, size = 32 }: { className?: string; size?: number }) {
  return (
    <div
      className={classNames('rd-9px ocp-center shrink-0', className)}
      style={{
        width: size,
        height: size,
        background: 'var(--ocp-charcoal)',
        fontSize: Math.round(size * 0.56),
        lineHeight: 1,
        fontFamily: '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif',
      }}
      aria-hidden="true"
    >
      {/*
        Flex centring aligns the glyph's advance width, not its ink, and the
        lobster sits left of centre inside its own advance — visibly off in a
        32px chip. Measured against the rendered ink box and expressed in em so
        it holds at any `size`.
      */}
      <span style={{ display: 'block', transform: 'translate(0.08em, 0.014em)' }}>🦞</span>
    </div>
  );
}
