import { Plus_Jakarta_Sans } from "next/font/google";

// Loaded via next/font so the 800 glyphs are self-hosted at build time — no
// runtime Google Fonts request and no FOUT on the wordmark. Matches the
// font-family in assets/mergewatch-wordmark.svg.
const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["800"],
  display: "swap",
});

/** Brand colors, kept in sync with assets/mergewatch-wordmark.svg. */
const BRAND_GREEN = "#16A34A";
const WORDMARK_GRAY = "#767C87";

/**
 * Logomark glyph — arc + filled dot with a transparent "eye" highlight.
 *
 * Geometry is a 1:1 port of assets/mergewatch-wordmark.svg: arc stroke-width
 * 82, dot r=108, highlight r=32.4 at (474.2, 601.2).
 *
 * The mark is brand green rather than `currentColor`. Green reads on both
 * light and dark backgrounds, which is the whole point of the SVG's dark-mode
 * fix — inheriting the surrounding text color made the mark invisible wherever
 * that color matched the background.
 *
 * The highlight is a hole punched with `fill-rule: evenodd`, not an opaque
 * circle, so it shows whatever is behind the mark. The standalone SVG achieves
 * the same thing with a `<mask>`; this uses evenodd because mask ids are
 * document-global and this component can render many times on one page.
 *
 * `size` sets the rendered height; width auto-scales to the glyph's ~1.89:1
 * aspect ratio.
 */
export function LogoMark({ size = 28, className }: { size?: number; className?: string }) {
  const width = Math.round(size * (692 / 366));
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="166 386 692 366"
      width={width}
      height={size}
      role="img"
      aria-label="MergeWatch logomark"
      className={className}
    >
      <path
        d="M 207 579.4 Q 512 274.4 817 579.4"
        fill="none"
        stroke={BRAND_GREEN}
        strokeWidth={82}
        strokeLinecap="round"
      />
      {/* Outer pupil + inner highlight as one path; evenodd makes the inner
          subpath a transparent hole rather than a painted circle. */}
      <path
        fillRule="evenodd"
        fill={BRAND_GREEN}
        d="M 404,644.4 a 108,108 0 1,0 216,0 a 108,108 0 1,0 -216,0
           M 441.8,601.2 a 32.4,32.4 0 1,0 64.8,0 a 32.4,32.4 0 1,0 -64.8,0"
      />
    </svg>
  );
}

/** Small icon variant for tight contexts (favicons, compact chrome). */
export function LogoIcon({ size = 20, className }: { size?: number; className?: string }) {
  return <LogoMark size={size} className={className} />;
}

/**
 * Full wordmark: logomark + "mergewatch" + green ".ai".
 *
 * Colors are fixed to the brand palette rather than inherited, matching
 * assets/mergewatch-wordmark.svg exactly so the embedded SVG (README, PR
 * comment footers) and the in-app wordmark render identically.
 */
export function Wordmark({ iconSize = 28, className }: { iconSize?: number; className?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-2 ${className ?? ""}`}>
      <LogoMark size={iconSize} className="shrink-0" />
      <span
        className={`whitespace-nowrap text-xl tracking-tight ${jakarta.className}`}
        style={{ fontWeight: 800, letterSpacing: "-0.02em", color: WORDMARK_GRAY }}
      >
        mergewatch<span style={{ color: BRAND_GREEN }}>.ai</span>
      </span>
    </span>
  );
}
