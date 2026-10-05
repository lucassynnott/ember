import { HL } from "./kernel.js";

/**
 * Waveform: Ember's mark as an object. Fifteen rounded bars stand on a long
 * plinth, and they speak: each bar's height breathes on two slow waves over a
 * resting shape that peaks in the middle, like the five bars of the logo. The
 * pointer is projected onto the plinth, and the bars around it rise toward it
 * on their springs, falling off with distance. The tallest bar at rest, and
 * the bar under the pointer when there is one, takes the bright stroke. The
 * slider is the radius, in bars.
 *
 * Ambient: the speech runs while the stage is on screen. Under reduced motion
 * the bars hold their resting shape until touched.
 */
const {
  Cam, clamp, facing, fit, prism, proj, rings, spring, stepS, reducedMotion,
  flatDot, mk, place, pointer, put, register, disposer, solid,
} = HL;

const N = 9, PITCH = 17, BW = 10, BD = 10, HMAX = 84, L = (N - 1) * PITCH + BW, PB = 5;

/** The resting shape: the logo's five bars, short, tall, tallest, tall, short, with a low bar either side. */
const REST = [9, 14, 27, 44, 58, 38, 25, 15, 10];
const shape = (i) => REST[i];
/** Speech: two slow waves that drift along the row, so the bars talk without ever lining up. */
const voice = (i, t) => 0.62 + 0.24 * Math.sin(t * 2.3 + i * 0.85) + 0.14 * Math.sin(t * 0.9 - i * 0.37);
/** The share of full height u radii from the pointer: 1 → .3 at 45% → .08 beyond. */
const falloff = (u) => (u <= 0 ? 1 : u <= 0.45 ? 1 - (u / 0.45) * 0.7 : u <= 1 ? 0.3 - ((u - 0.45) / 0.55) * 0.22 : 0.08);

function mount({ stage, svg, read }, value) {
  const bag = disposer();
  const C = Cam(45, 0.5, 2.02);
  fit(C, [[-8, -8, -PB], [L + 8, BD + 8, -PB], [L + 8, -8, -PB], [-8, BD + 8, -PB], [0, 0, HMAX], [L, 0, HMAX]], 200, 170);
  const P = proj(C), front = facing(C);
  let R = value, over = null, clock = 0;

  const g = mk("g", {}, svg);
  const [pr, pi] = rings(-8, -8, L + 8, BD + 8, 8, 2.2);
  put(solid(g), prism(P, front, pr, pi, -PB, 0));
  // a groove along the plinth, behind the bars: the line they stand on
  mk("path", { class: "nf lo", d: `M${P(-3, BD + 3.5, 0).join(" ")}L${P(L + 3, BD + 3.5, 0).join(" ")}` }, g);

  // By ascending x: each bar is nearer than the one before it, so appending paints back to front.
  const bars = [];
  for (let i = 0; i < N; i++) {
    const x0 = i * PITCH, [ring, inner] = rings(x0, 0, x0 + BW, BD, 4.6, 1.1);
    const h0 = shape(i);
    bars.push({ i, h0, ring, inner, sp: spring(h0, { eps: 0.05 }), el: solid(g), drawn: NaN });
  }
  const peak = bars[4];
  // Hit test on the rest pose: each bar's resting centre on screen (rule 01). The row runs left to
  // right on screen, so the pointer's x finds its place along it; its y only has to be near the row.
  const sx = bars.map((b) => P(b.i * PITCH + BW / 2, BD / 2, 0));
  function along([px, py]) {
    if (px < sx[0][0] - 22 || px > sx[N - 1][0] + 22) return null;
    const k = clamp((px - sx[0][0]) / (sx[N - 1][0] - sx[0][0]), 0, 1) * (N - 1);
    const gy = sx[0][1] + (sx[N - 1][1] - sx[0][1]) * (k / (N - 1));
    if (py < gy - HMAX * C.S - 24 || py > gy + 34) return null;
    return k * PITCH + BW / 2;
  }
  // a dot on the plinth in front of the bar that is lit
  const tick = flatDot(g, C, 1.1, "dot");

  function draw(b) {
    const h = Math.max(1.2, b.sp.x);
    if (Math.abs(h - b.drawn) < 0.01) return;
    b.drawn = h;
    put(b.el, prism(P, front, b.ring, b.inner, 0, h));
  }

  let lit = peak;
  const B = register(stage, (dt) => {
    const still = reducedMotion();
    if (!still) clock += dt;
    let moving = !still;
    const x = over;
    for (const b of bars) {
      const talk = still ? b.h0 : b.h0 * voice(b.i, clock);
      const lift = x === null ? 0 : HMAX * falloff(Math.abs(b.i * PITCH + BW / 2 - x) / (R * PITCH));
      b.sp.t = Math.max(talk, lift);
      if (stepS(b.sp, dt)) moving = true;
      draw(b);
    }
    return moving;
  });
  bag.add(B.unregister);

  function choose() {
    const i = over === null ? -1 : clamp(Math.round((over - BW / 2) / PITCH), 0, N - 1);
    const next = i < 0 ? peak : bars[i];
    if (next !== lit) { lit.el.sil.classList.remove("hi"); lit = next; }
    lit.el.sil.classList.add("hi");
    place(tick, P(lit.i * PITCH + BW / 2, BD + 3.5, 0));
    tick.setAttribute("class", i < 0 ? "dot m" : "dot");
    read.textContent = i < 0 ? "rest" : `bar ${i + 1}`;
    B.wake();
  }
  choose();

  bag.add(pointer(stage, {
    move: (p) => { over = along(p); choose(); },
    leave: () => { over = null; choose(); },
  }));
  bag.add(() => svg.replaceChildren());
  return { set: (v) => { R = v; B.wake(); }, destroy: bag.dispose };
}

export const waveform = ({
  name: "waveform",
  means: "Ember's bars speak on a plinth; the ones near the pointer rise to it, falling off with distance.",
  rules: [1, 3, 5, 9],
  range: [1, 1.8, 3],
  mount,
});
