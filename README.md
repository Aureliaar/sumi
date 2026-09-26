# Sumi

A real-time brush and ink simulation for writing calligraphy with your finger, a stylus, or a mouse. It runs in the browser with WebGL 2 and has no build step or dependencies.

## Using it

Press and drag to write.

- **Speed controls width.** Slow strokes swell, fast strokes thin out.
- **Resting pools ink.** Hold still and the brush spreads into a darker blob.
- **Lifting while moving flicks a tail.** The stroke tapers into a streaky sweep that follows your curve.
- **The brush runs dry.** Long or fast strokes break into dry-brush streaks. Pausing between strokes re-inks it.
- **Ink stays wet for a few seconds.** It bleeds along the paper fibers and darkens at the edges as it dries.

The toolbar has a practice grid with a ghost character, three brush sizes, dark or diluted ink, a seal stamp, undo (up to six steps, or Ctrl/Cmd+Z), and a new sheet.

## Running locally

Open `public/index.html` in a browser. To test on a phone on the same network, serve the folder:

```sh
python3 -m http.server 8000 -d public
```

Or run it through Wrangler with `npm install` then `npm run dev`.

## Deploying

The site is served as static assets by a Cloudflare Worker at https://sumi.aure.onl. Every push to `main` deploys through `.github/workflows/deploy.yml` (`wrangler deploy`), using the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repo secrets. Everything the page serves lives in `public/`.

## How it works

Everything is in `public/sumi.js`. There are five GPU passes and one CPU-side brush model.

**Brush input (CPU).** Pointer events, including coalesced events, drive a smoothed brush tip. Width comes from speed, dwell time, remaining ink, and stylus pressure when available. The brush emits overlapping "dabs" along its path, and on release it extrapolates a tapered tail along its velocity and curvature. Ink load drops with distance and speed and partly recovers during pauses.

**Dab pass.** Dabs are drawn as instanced quads into the simulation texture. Wet pigment is blended additively and water with `MAX`, so a resting brush pools ink but water doesn't pile up without limit. Each dab carries pigment per unit area times its spacing, and each fragment divides that by the length of the run of dab centres that cover it (the footprint's chord along the motion, clipped to the stroke's start and end). Overlapping dabs therefore sum to a flat, fully covering body with crisp edges and solid caps, instead of piling up in the middle.

**Dry map.** At startup the page builds a 320×2048 texture that stands in for a scanned dry-brush print. Its red channel holds about 160 bristles grouped into 8 tufts; each bristle wanders sideways and runs dry in its own rhythm. Its green channel holds the tuft groupings. Both channels are histogram-equalized, so a threshold of *t* leaves about (1 − *t*) of the area inked. Each dab samples the texture in stroke space, with across-brush position on one axis and distance along the stroke on the other. Dryness raises the threshold, pressure lowers it, and the edges of the brush dry first. As the brush dries or is pressed flat, the tufts separate. A dry, lightly pressed brush also skips the valleys of the paper grain. Thin "stray hairs" can leave the body of the stroke when the brush is dry, bent hard, or flicked.

**Wet-paper simulation.** A ping-pong half-float texture holds wet pigment, deposited pigment, and water. Each step moves water to neighboring cells in proportion to paper permeability, which is higher along fibers, so bleeding is feathery. Pigment moves with the water. Water evaporates faster at the edge of a wet area, which pulls pigment outward and darkens stroke edges as they dry. Pigment deposits faster as the water disappears and settles more in the grain's high spots.

**Paper.** Procedural washi is baked once per resize: grain height, curved fibers, uneven thickness, and a few bark flecks.

**Composite.** Ink density becomes color through a Beer–Lambert-style absorption curve with a shoulder. Absorption is close to neutral, and dense ink keeps a soft warm-black floor that pooled ink sinks below, rather than printing flat black. Paper texture shows only through thin ink. Wet ink gets a slight darkening and a specular highlight based on the slope of its water surface. Seals are drawn with Canvas 2D and multiplied in with a mottled, uneven impression.

If the browser can't render to half-float textures, the simulation falls back to 8-bit and loses some subtlety in the drying.

**Written characters.** The practice guide's "write it" button replays a per-character sweep (centreline points with a radius) through the same brush. The sweeps start from KanjiVG stroke paths and are refit to each font by `public/tools/fit.js`: the whole character is scaled and shifted onto the glyph, each stroke slides to unclaimed ink nearby, the centreline snaps to the glyph's medial ridge, the radius comes from the glyph's distance transform (clamped where strokes cross), paths that cross paper are split, and stroke ends follow the ridge out to the glyph's own tips.

## Tools

[`/tools/contact-sheet.html`](https://sumi.aure.onl/tools/contact-sheet.html) renders each character three ways: the font glyph (target), the brush replay after the paper has dried (system), and a diff of the two ink masks, with IoU, coverage and spill. Add `?chars=永心` to pick characters, `?fit=1` to fit the sweeps on the fly, and use **Export refit sweeps.js** to regenerate `public/sweeps.js`. The page drives the app through a hook that only exists when `index.html` is opened with `?harness`.

## References

- Nelson S.-H. Chu and Chiew-Lan Tai, "Real-Time Painting with an Expressive Virtual Chinese Brush," *IEEE Computer Graphics and Applications* 24(5), 2004. The dry map, split map, and paper-grain thresholding here follow this paper's approach.
- Nelson S.-H. Chu and Chiew-Lan Tai, "MoXi: Real-Time Ink Dispersion in Absorbent Paper," *ACM Transactions on Graphics* 24(3), 2005.
- Steve Strassmann, "Hairy Brushes," *SIGGRAPH '86*.

## Ideas

- Build the dry map from a photographed dry-brush stroke instead of generating it.
- Add a tint choice for the densest ink, such as blue-black pine soot or brown-black oil soot.
- Save the sheet as an image.
- Model brush tilt and the off-center tip used in many calligraphy strokes.

## License

MIT. See `LICENSE`.
