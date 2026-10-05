import { HL } from "./kernel.js";

/**
 * Catalogue: a card cabinet of three drawers, one per board, each with a pull
 * and an empty label frame, full of cards standing on end. Nobody touching
 * it, the drawers take turns: one slides out, shows its cards, and goes back
 * as the next comes out. The pointer's height picks a drawer; it slides out
 * on the 700ms lift curve, its neighbours ease out a little after it, and the
 * turns stop until the pointer leaves. The drawer that is out has the bright
 * front. The read-out names the board. The slider is the stagger, in ms.
 */
const {
  Cam, clamp, facing, fit, prism, proj, rings, rrect, ringAt, open, poly, seg,
  tween, tset, tval, tdone, reducedMotion, mk, pointer, put, register, disposer, solid,
} = HL;

const W = 96, D = 74, PL = 6, DH = 30, N = 3, H = PL + N * DH, OUT = 46, NEAR = 12, TURN = 2600;
const X0 = 8, X1 = W - 8, CARDS = 7;

function mount({ stage, svg, read }, value) {
  const bag = disposer();
  let stag = value, over = -1, turn = 1, nextTurn = performance.now() + TURN;
  const C = Cam(45, 0.5, 1.72);
  fit(C, [[0, 0, 0], [W, D + OUT + 4, 0], [W, 0, 0], [0, D + OUT + 4, 0], [0, 0, H + 4], [W, D, H + 4]], 200, 166);
  const P = proj(C), front = facing(C);

  const g = mk("g", {}, svg);
  // the cabinet: a plinth, then the carcass standing on it, its top with a lid line
  const [pr, pi] = rings(-2, -2, W + 2, D + 2, 4, 1.2);
  put(solid(g), prism(P, front, pr, pi, 0, PL));
  const [cr, ci] = rings(0, 0, W, D, 4, 1.6);
  put(solid(g), prism(P, front, cr, ci, PL, H));
  // where each drawer sits in the carcass: a dark slot on the front face, behind the drawer
  for (let k = 0; k < N; k++) {
    const z0 = PL + k * DH + 2, z1 = z0 + DH - 4;
    mk("path", { class: "nf lo", d: poly([P(X0 - 3, D, z0), P(X1 + 3, D, z0), P(X1 + 3, D, z1), P(X0 - 3, D, z1)]) }, g);
  }

  // Drawers from the bottom up: a higher drawer is nearer the eye, so it paints later.
  const drawers = [];
  for (let k = 0; k < N; k++) {
    const z0 = PL + k * DH + 3, z1 = z0 + DH - 6;
    const el = { g: mk("g", {}, g) };
    el.tray = solid(el.g);
    el.cards = mk("path", { class: "nf" }, el.g);
    el.face = solid(el.g);
    el.marks = mk("path", { class: "nf lo" }, el.g);
    drawers.push({ k, z0, z1, el, out: tween(k === turn ? OUT * 0.7 : 0), drawn: NaN });
  }

  function draw(d, out) {
    if (out === d.drawn) return;
    d.drawn = out;
    const { z0, z1, el } = d, yF = D + out;
    // the tray: from the carcass face to the front panel, open on top
    if (out > 0.5) {
      const [tr, ti] = rings(X0, D - 2, X1, yF, 2, 1.2);
      put(el.tray, prism(P, front, tr, ti, z0, z1 - 4));
      el.tray.g.removeAttribute("visibility");
      // the cards: thin plates standing across the tray, the ones nearer the front shorter
      const c = [];
      for (let j = 0; j < CARDS; j++) {
        const y = yF - 4 - j * 5.5;
        if (y < D + 1) break;
        const h = z1 - 2 + (j % 3 === 1 ? 3 : 0);
        c.push(open([P(X0 + 4, y, z1 - 6), P(X0 + 4, y, h), P(X1 - 4, y, h), P(X1 - 4, y, z1 - 6)]));
      }
      el.cards.setAttribute("d", c.join(""));
    } else {
      el.tray.g.setAttribute("visibility", "hidden");
      el.cards.setAttribute("d", "");
    }
    // the front panel, a little larger than the tray, with a label frame and a pull
    const [fr, fi] = rings(X0 - 3, yF, X1 + 3, yF + 3, 1.4, 0.6);
    put(el.face, prism(P, front, fr, fi, z0 - 1, z1 + 1));
    const cx = (X0 + X1) / 2, y = yF + 3, lz = z1 - 5;
    el.marks.setAttribute("d",
      poly([P(cx - 12, y, lz), P(cx + 12, y, lz), P(cx + 12, y, lz - 7), P(cx - 12, y, lz - 7)]) +
      seg(P(cx - 9, y, z0 + 6), P(cx + 9, y, z0 + 6)) + seg(P(cx - 9, y, z0 + 4), P(cx + 9, y, z0 + 4)));
  }

  /** Opens drawer a (or none): its neighbours follow it out a little, later the farther they are. */
  function open_(a, now) {
    drawers.forEach((d, k) => {
      const target = a < 0 ? 0 : k === a ? OUT : Math.abs(k - a) === 1 ? NEAR : 0;
      tset(d.out, target, now, a < 0 ? 0 : Math.abs(k - a) * stag);
      d.el.face.sil.classList.toggle("hi", k === a);
    });
  }

  const B = register(stage, (_dt, now) => {
    // the turns: only while nobody is pointing, and never under reduced motion
    if (over < 0 && !reducedMotion() && now >= nextTurn) { turn = (turn + 1) % N; nextTurn = now + TURN; open_(turn, now); }
    let moving = false;
    for (const d of drawers) { draw(d, tval(d.out, now)); if (!tdone(d.out, now)) moving = true; }
    return moving || (over < 0 && !reducedMotion());
  });
  bag.add(B.unregister);
  open_(turn, performance.now());

  // Hit test on the rest pose: the carcass face, split into the three drawer heights (rule 01).
  const faceTop = P(W / 2, D, H)[1], faceBot = P(W / 2, D, PL)[1];
  function pick([x, y]) {
    const left = P(0, D, 0)[0] - 14, right = P(W, D + OUT, 0)[0] + 14;
    if (x < left || x > right) return -1;
    const t = (faceBot - (y - (x - P(W / 2, D, 0)[0]) * 0.5)) / (faceBot - faceTop);
    return t < -0.15 || t > 1.15 ? -1 : clamp(Math.floor(t * N), 0, N - 1);
  }
  function point(a) {
    if (a === over) return;
    over = a;
    const now = performance.now();
    if (a >= 0) open_(a, now);
    else { nextTurn = now + 900; open_(turn, now); }
    read.textContent = a < 0 ? "rest" : `board ${N - a}`;
    B.wake();
  }
  read.textContent = "rest";
  bag.add(pointer(stage, { move: (p) => point(pick(p)), leave: () => point(-1) }));
  bag.add(() => svg.replaceChildren());
  return { set: (v) => { stag = v; }, destroy: bag.dispose };
}

export const catalogue = ({
  name: "catalogue",
  means: "A card cabinet with a drawer for each board; the drawers take turns, and the one by the pointer slides out.",
  rules: [1, 2, 5, 8],
  range: [0, 50, 110],
  mount,
});
