import { HL } from "./kernel.js";

/**
 * Reel: an open-reel recorder taking down a call. Two reels turn on a deck;
 * tape runs from the full one, across the recording head, onto the empty one,
 * so the left pack shrinks as the right one grows, lap after lap. Hovering
 * never stops the recording: it springs the clock's rate down to the slider's
 * value, so the reels keep turning, slowly enough to follow a spoke. The head,
 * the one bright part, is what is listening. The read-out is the call's time.
 *
 * Ambient: the reels turn while the stage is on screen. Under reduced motion
 * they hold still until hovered, when they creep at the slider's rate.
 */
const {
  Cam, circ, clamp, facing, fit, prism, proj, rings, seg, open, spring, stepS, reducedMotion,
  mk, pointer, put, register, disposer, solid,
} = HL;

const DW = 150, DD = 86, DT = 7, RR = 30, RZ = 3, HUB = 6, CX = [38, 112], CY = 38, HEAD = [75, 76], LAP = 14;

/** A ring of radius r round (cx, cy), as world points at height z, for paths drawn on a reel's face. */
const around = (cx, cy, r, z, n = 40) => Array.from({ length: n + 1 }, (_, k) => [cx + r * Math.cos((k / n) * 2 * Math.PI), cy + r * Math.sin((k / n) * 2 * Math.PI), z]);

function mount({ stage, svg, read }, value) {
  const bag = disposer();
  let slow = value, over = false, clock = 0;
  const rate = spring(1, { eps: 0.002 });
  const C = Cam(45, 0.5, 1.98);
  fit(C, [[-4, -4, -DT], [DW + 4, DD + 4, -DT], [DW + 4, -4, -DT], [-4, DD + 4, -DT], [CX[0], CY - RR, RZ + 6], [CX[1], CY, RZ + 6]], 200, 168);
  const P = proj(C), front = facing(C);

  const g = mk("g", {}, svg);
  const [dr, di] = rings(-4, -4, DW + 4, DD + 4, 9, 2);
  put(solid(g), prism(P, front, dr, di, -DT, 0));
  // the transport's keys along the near edge: a recessed row the deck would really have
  const keys = mk("path", { class: "nf lo" }, g);
  keys.setAttribute("d", [0, 1, 2].map((k) => open(around(12 + k * 15, DD - 10, 4.2, 0, 16).map((p) => P(...p)))).join(""));

  // By x + y: the far reel, the tape leaving it, the head, then the near reel.
  const tape = mk("path", { class: "nf" }, g);
  const reels = CX.map((cx) => {
    const el = solid(g), packEl = mk("path", { class: "nf lo" }, el.g), spokes = mk("path", { class: "nf" }, el.g);
    const hub = solid(el.g);
    put(el, prism(P, front, circ(RR, 40).map((q) => ({ ...q, u: q.u + cx, v: q.v + CY })), circ(RR - 1.4, 40).map((q) => ({ ...q, u: q.u + cx, v: q.v + CY })), 0, RZ));
    const [hr, hi] = rings(cx - HUB, CY - HUB, cx + HUB, CY + HUB, HUB, 1.2);
    put(hub, prism(P, front, hr, hi, RZ, RZ + 5));
    return { cx, packEl, spokes, hub };
  });
  const head = solid(g);
  const [hr, hin] = rings(HEAD[0] - 9, HEAD[1] - 5, HEAD[0] + 9, HEAD[1] + 5, 3, 1.1);
  put(head, prism(P, front, hr, hin, 0, 12));
  head.sil.classList.add("hi");
  // the head's gap, where the tape is heard: one line across its face
  mk("path", { class: "nf", d: seg(P(HEAD[0], HEAD[1] + 5, 4), P(HEAD[0], HEAD[1] + 5, 10)) }, head.g);
  // the near reel paints after the head, and the tape lies on the far reel, under the head and the near reel
  g.appendChild(reels[1].packEl.parentNode);
  reels[0].packEl.parentNode.after(tape);

  let drawnAt = NaN;
  function draw() {
    const lap = (clock / LAP) % 1, angle = clock * 2.4;
    if (angle === drawnAt) return;
    drawnAt = angle;
    // the tape moves from the left pack to the right one; each pack is a ring on its reel's face
    const pack = [RR - 3 - lap * 15, RR - 18 + lap * 15];
    reels.forEach((r, k) => {
      r.packEl.setAttribute("d", open(around(r.cx, CY, pack[k], RZ, 48).map((p) => P(...p))));
      const sp = [];
      for (let s = 0; s < 3; s++) {
        const a = angle + (s * 2 * Math.PI) / 3;
        sp.push(seg(P(r.cx + Math.cos(a) * (HUB + 1.5), CY + Math.sin(a) * (HUB + 1.5), RZ), P(r.cx + Math.cos(a) * (pack[k] - 2), CY + Math.sin(a) * (pack[k] - 2), RZ)));
      }
      r.spokes.setAttribute("d", sp.join(""));
    });
    // each run of tape leaves its pack at the side nearest the head, at the reel's face
    const z = RZ + 0.4, l = pack[0], r = pack[1];
    tape.setAttribute("d", open([P(CX[0] + l * 0.55, CY + l * 0.83, z), P(HEAD[0] - 8, HEAD[1] - 5.5, z), P(HEAD[0] + 8, HEAD[1] - 5.5, z), P(CX[1] - r * 0.55, CY + r * 0.83, z)]));
    const secs = Math.floor(754 + clock * 1.0);
    read.textContent = over ? `rec ${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}` : "rest";
  }

  const B = register(stage, (dt) => {
    let m = stepS(rate, dt);
    const base = reducedMotion() ? 0 : 1;
    if (!over) rate.t = base;
    clock += dt * rate.x;
    draw();
    if (reducedMotion() && !over && rate.x === 0) return m;
    return true;
  });
  bag.add(B.unregister);
  draw();

  bag.add(pointer(stage, {
    move: () => { over = true; rate.t = slow; B.wake(); },
    leave: () => { over = false; B.wake(); },
  }));
  bag.add(() => svg.replaceChildren());
  return { set: (v) => { slow = clamp(v, 0, 1); if (over) rate.t = slow; B.wake(); }, destroy: bag.dispose };
}

export const reel = ({
  name: "reel",
  means: "A recorder takes the call down; hovering slows its reels so you can follow them, never stopping the tape.",
  rules: [5, 7, 8, 9],
  range: [0.45, 0.25, 0.08],
  mount,
});
