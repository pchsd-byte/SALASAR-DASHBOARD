import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';

// The blessing shown on the way in, once, for three seconds.
//
// It plays on a *fresh sign-in only*: the OAuth callback sends people to `/?welcome=1`
// (auth.controller.js) and this reads that flag, then strips it from the URL straight away. That
// matters because reloading the page is how everyone refreshes the figures (§8.2) — keyed on
// anything else, this would greet the same person a dozen times a morning.
//
// The surround is taken from the picture itself rather than invented: its own tones are pearl
// white with warm rose-grey and a cream halo (mean R−B +15, warm), so the backdrop is a warm
// ivory glow that its soft edges dissolve into with no visible border. The frame is gold with
// Salasar's red (#dc1f2b, the same red as the mark in the navbar) — which is also the auspicious
// colour for this, so the brand and the occasion want the same thing.

const SHOW_MS = 3000;
const BRAND_RED = '#dc1f2b';
const GOLD = '#c9a227';
const GOLD_LIGHT = '#f0d98a';

// Devanagari that is already on the machine — the app loads no web fonts, and a blessing that
// waits on a font request is a blessing nobody sees inside three seconds.
const DEVANAGARI = "'Noto Serif Devanagari', 'Noto Sans Devanagari', 'Nirmala UI', 'Mangal', 'Kokila', serif";

const MANTRA = 'ॐ ऐं सरस्वत्यै नमः';
const COUPLET = ['अज्ञानता का अंधेरा मिट जाए जीवन से,', 'सद्बुद्धि का वरदान मिले माँ के चरणों के वंदन से'];

// Petals drift at their own pace and start off-screen at their own moment, so the fall never
// reads as one row of identical objects coming down together.
const PETALS = [
  { left: 4, delay: 0.0, dur: 4.2, size: 17, tone: 0, spin: -320 },
  { left: 11, delay: 1.1, dur: 5.4, size: 12, tone: 1, spin: 280, blossom: true },
  { left: 18, delay: 0.45, dur: 4.8, size: 20, tone: 2, spin: -210 },
  { left: 25, delay: 2.0, dur: 4.0, size: 14, tone: 0, spin: 350 },
  { left: 32, delay: 0.8, dur: 5.8, size: 11, tone: 1, spin: -260 },
  { left: 39, delay: 1.6, dur: 4.4, size: 18, tone: 2, spin: 300, blossom: true },
  { left: 46, delay: 0.2, dur: 5.1, size: 13, tone: 0, spin: -340 },
  { left: 53, delay: 2.3, dur: 4.6, size: 16, tone: 1, spin: 240 },
  { left: 60, delay: 0.95, dur: 5.6, size: 12, tone: 2, spin: -290 },
  { left: 67, delay: 1.8, dur: 4.1, size: 19, tone: 0, spin: 320, blossom: true },
  { left: 74, delay: 0.35, dur: 5.2, size: 14, tone: 1, spin: -250 },
  { left: 81, delay: 2.5, dur: 4.7, size: 11, tone: 2, spin: 360 },
  { left: 88, delay: 1.25, dur: 5.0, size: 17, tone: 0, spin: -300 },
  { left: 95, delay: 0.6, dur: 4.3, size: 13, tone: 1, spin: 270, blossom: true },
  { left: 8, delay: 2.8, dur: 5.5, size: 15, tone: 2, spin: -230 },
  { left: 43, delay: 3.1, dur: 4.9, size: 12, tone: 0, spin: 310 },
  { left: 71, delay: 3.4, dur: 5.3, size: 16, tone: 1, spin: -280 },
  { left: 29, delay: 3.7, dur: 4.5, size: 13, tone: 2, spin: 330, blossom: true },
];

// Rose, deeper rose, marigold — the flowers actually thrown at a puja, and all three sit in the
// picture's own warm range.
const PETAL_TONES = [
  ['#f7c9d4', '#e98fa8'],
  ['#f4b8c4', '#d9607f'],
  ['#ffd98a', '#f0a92e'],
];

function Petal({ left, delay, dur, size, tone, spin, blossom }) {
  const [light, dark] = PETAL_TONES[tone];
  const id = `sb${left}${tone}${blossom ? 'b' : 'p'}`;
  return (
    <span
      className="sb-petal"
      style={{ left: `${left}%`, width: size * (blossom ? 1.3 : 1), height: size * (blossom ? 1.3 : 1.35), animationDelay: `${delay}s`, animationDuration: `${dur}s`, '--sb-spin': `${spin}deg` }}
    >
      <svg viewBox="0 0 32 32" width="100%" height="100%" aria-hidden="true">
        <defs>
          <linearGradient id={id} x1="0.1" y1="0" x2="0.9" y2="1">
            <stop offset="0%" stopColor={light} />
            <stop offset="100%" stopColor={dark} />
          </linearGradient>
        </defs>
        {blossom ? (
          // A whole small flower, as thrown by the handful.
          <g>
            {[0, 72, 144, 216, 288].map((a) => (
              <ellipse key={a} cx="16" cy="8.5" rx="5.2" ry="7.5" fill={`url(#${id})`} transform={`rotate(${a} 16 16)`} />
            ))}
            <circle cx="16" cy="16" r="3.4" fill={GOLD_LIGHT} />
            <circle cx="16" cy="16" r="1.6" fill={GOLD} />
          </g>
        ) : (
          // A single petal: broad and round at the lip, narrowing to the point where it was
          // joined. A teardrop reads as a raindrop, which is the wrong festival.
          <g>
            <path d="M16 31C7.5 26.5 3 20 3 13.5 3 7 8.5 1 16 1s13 6 13 12.5C29 20 24.5 26.5 16 31z" fill={`url(#${id})`} />
            <path d="M16 3.5c-3.6 4-5.4 8-5.4 12.2 0 3.6 1.7 7.4 5.4 11.6" stroke={light} strokeWidth="1.1" fill="none" opacity="0.65" />
          </g>
        )}
      </svg>
    </span>
  );
}

// A small gold rosette, used where the frame's rules meet.
function Rosette({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="shrink-0">
      {[0, 45, 90, 135].map((a) => (
        <ellipse key={a} cx="12" cy="12" rx="3.2" ry="10" fill={GOLD} opacity="0.5" transform={`rotate(${a} 12 12)`} />
      ))}
      <circle cx="12" cy="12" r="3.4" fill={BRAND_RED} />
      <circle cx="12" cy="12" r="1.5" fill={GOLD_LIGHT} />
    </svg>
  );
}

// The torana — the arch hung over a shrine doorway. Drawn rather than imported so it inherits the
// frame's gold and carries the brand red in its drops.
function Torana() {
  return (
    <svg viewBox="0 0 400 46" className="sb-torana block w-full" style={{ height: 'clamp(20px, min(4vw, 3.4vh), 40px)' }} aria-hidden="true" preserveAspectRatio="none">
      <path d="M0 2h400" stroke={GOLD} strokeWidth="2.5" fill="none" />
      {Array.from({ length: 17 }, (_, i) => {
        const x = 12 + i * 23.5;
        const drop = i % 2 === 0 ? 30 : 20;
        return (
          <g key={x}>
            <path d={`M${x} 2 Q${x + 11.75} ${drop + 12} ${x + 23.5} 2`} stroke={GOLD} strokeWidth="1.6" fill="none" opacity="0.85" />
            <circle cx={x + 11.75} cy={drop + 5} r="3" fill={i % 2 === 0 ? BRAND_RED : GOLD} />
            <circle cx={x + 11.75} cy={drop + 5} r="1.1" fill={GOLD_LIGHT} opacity="0.9" />
          </g>
        );
      })}
    </svg>
  );
}

export function WelcomeBlessing() {
  const [open, setOpen] = useState(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('welcome') === '1';
  });

  // Take the flag out of the URL the moment it is read, so a reload — or a link someone copies
  // out of the address bar — does not play it again.
  useEffect(() => {
    if (!open) return undefined;
    const url = new URL(window.location.href);
    url.searchParams.delete('welcome');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);

    const timer = setTimeout(() => setOpen(false), SHOW_MS);
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(timer); window.removeEventListener('keydown', onKey); };
  }, [open]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="blessing"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.5, ease: 'easeInOut' } }}
          transition={{ duration: 0.45 }}
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-[100] flex items-center justify-center overflow-hidden px-4"
          style={{ background: 'radial-gradient(ellipse at 50% 42%, rgba(255,250,240,0.97) 0%, rgba(246,232,222,0.96) 45%, rgba(214,190,185,0.95) 100%)', backdropFilter: 'blur(3px)' }}
          role="dialog"
          aria-label="स्वागत — माँ सरस्वती वंदना"
        >
          <style>{`
            @keyframes sb-fall {
              0%   { transform: translateY(-14vh) rotate(0deg); opacity: 0; }
              12%  { opacity: 0.95; }
              88%  { opacity: 0.9; }
              100% { transform: translateY(104vh) rotate(var(--sb-spin)); opacity: 0; }
            }
            @keyframes sb-glow {
              0%, 100% { opacity: 0.55; transform: scale(1); }
              50%      { opacity: 0.9;  transform: scale(1.06); }
            }
            .sb-petal { position: absolute; top: 0; animation-name: sb-fall; animation-timing-function: linear; animation-iteration-count: infinite; will-change: transform, opacity; }
            .sb-glow  { animation: sb-glow 3s ease-in-out infinite; }
            @media (prefers-reduced-motion: reduce) {
              .sb-petal { display: none; }
              .sb-glow  { animation: none; opacity: 0.7; }
            }

            /* Every size below is bounded by the viewport's HEIGHT as well as its width. Sized on
               width alone, the frame came out 605px tall on a 390px-tall landscape phone and hung
               off both ends of the screen. min(vw, vh) is what keeps it on screen on a laptop in
               a short window as much as on a phone turned sideways. */
            /* fit-content, not 100%: the frame hugs whichever is wider, the picture or the couplet,
               instead of stretching to its cap and leaving a band of empty ivory down both sides
               on a monitor. */
            .sb-card    { width: fit-content; max-width: min(660px, 94vw); max-height: 94vh; }
            .sb-body    { display: grid; grid-template-areas: "mantra" "art" "words"; justify-items: center; }
            /* Stacked, the wrapper is not a box at all - its two children become grid items in
               their own right, so the areas above put the mantra over her and the couplet under
               her however the markup happens to be ordered. */
            .sb-side    { display: contents; }
            .sb-head    { grid-area: mantra; }
            .sb-art     { grid-area: art; }
            .sb-words   { grid-area: words; }
            .sb-art     { width: clamp(188px, min(72vw, 52vh), 500px); }
            .sb-mantra  { font-size: clamp(17px, min(4.6vw, 3.6vh), 29px); }
            .sb-couplet { font-size: clamp(11px, min(3vw, 2.15vh), 16.5px); }
            .sb-foot    { font-size: clamp(9px, min(2.3vw, 1.65vh), 12.5px); }
            .sb-rule    { width: clamp(34px, 9vw, 84px); }
            /* Centred under the mantra when stacked; flush left when it sits beside her. */
            .sb-headrule { justify-content: center; }

            /* Laptops and monitors. A 620px frame centred on a 1920 or 2560 screen reads as a
               notification rather than an occasion, and these screens have the height to spare
               that a 768px laptop does not — which is why this is gated on height too, and why a
               1366x768 laptop stays on the sizes above. */
            @media (min-width: 1200px) and (min-height: 820px) {
              .sb-card    { max-width: min(860px, 72vw); }
              .sb-art     { width: clamp(320px, min(42vw, 52vh), 620px); }
              .sb-mantra  { font-size: clamp(26px, min(2.6vw, 3.6vh), 42px); }
              .sb-couplet { font-size: clamp(15px, min(1.45vw, 2vh), 23px); }
              .sb-foot    { font-size: clamp(11px, min(1vw, 1.4vh), 16px); }
              .sb-rule    { width: clamp(60px, 7vw, 130px); }
            }

            /* Wide and not tall: a phone turned sideways, and equally a 16:9 laptop. A portrait
               frame on a 1366x768 screen has to shrink to fit the height and then fights the
               shape of the screen, so beyond this point she takes the left and everything that is
               words goes beside her. Tall monitors (1050px and up) keep the poster. */
            @media (orientation: landscape) and (max-height: 920px) {
              .sb-card  { max-width: min(1080px, 92vw); }
              /* Plain flex here, not a two-row grid with the picture spanning both: a spanning
                 item inflates content-sized tracks, so the mantra and the couplet were pushed to
                 opposite ends of her with a hole between them. The wrapper becomes a real box and
                 centres the words against her as one group. */
              .sb-body  { display: flex; align-items: center; text-align: left;
                          gap: clamp(10px, 2.5vw, 34px); }
              .sb-side  { display: flex; flex-direction: column; justify-content: center;
                          flex: 1 1 auto; min-width: 0; gap: clamp(4px, 1.8vh, 18px); }
              /* One formula covers a 390px-tall phone and a 768px-tall laptop. */
              .sb-art   { width: min(38vw, 68vh); flex: none; }
              .sb-mantra  { font-size: clamp(15px, min(2.4vw, 4.6vh), 40px); }
              .sb-couplet { font-size: clamp(10.5px, min(1.45vw, 2.6vh), 22px); }
              .sb-foot    { font-size: clamp(8.5px, min(1vw, 1.9vh), 15px); }
              .sb-rule    { width: clamp(26px, 5vw, 110px); }
              .sb-headrule { justify-content: flex-start; }
              .sb-torana  { height: clamp(16px, min(3vw, 4.4vh), 34px) !important; }
            }
          `}</style>

          {/* Flowers thrown over the whole view, behind the frame. */}
          <div className="pointer-events-none absolute inset-0" aria-hidden="true">
            {PETALS.map((p) => <Petal key={`${p.left}-${p.delay}`} {...p} />)}
          </div>

          <motion.div
            initial={{ scale: 0.9, y: 18 }}
            animate={{ scale: 1, y: 0 }}
            transition={{ duration: 0.55, ease: [0.2, 0.8, 0.25, 1] }}
            className="sb-card relative"
          >
            {/* The frame: a gold double rule on warm ivory, the picture's own ground. */}
            <div
              className="relative overflow-hidden rounded-[22px] px-3 pb-3 pt-0 text-center sm:px-6"
              style={{
                background: 'linear-gradient(170deg, #fffdf6 0%, #fdf4e7 42%, #f7e6dd 100%)',
                border: `1.5px solid ${GOLD}`,
                boxShadow: `0 0 0 5px rgba(201,162,39,0.14), 0 0 0 6.5px rgba(220,31,43,0.30), 0 26px 70px -18px rgba(90,40,30,0.5)`,
              }}
            >
              <Torana />

              <div className="sb-body">
                {/* Her. The glow sits behind so the cut-out's soft edge has somewhere to go. */}
                <div className="sb-art relative mt-0.5">
                  <div
                    className="sb-glow pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
                    aria-hidden="true"
                    style={{ width: '122%', height: '122%', background: 'radial-gradient(circle, rgba(255,240,190,0.95) 0%, rgba(255,226,170,0.5) 42%, rgba(255,226,170,0) 70%)' }}
                  />
                  <img
                    src="/saraswati.webp"
                    alt="माँ सरस्वती"
                    className="relative block w-full"
                    style={{ filter: 'drop-shadow(0 10px 22px rgba(120,70,50,0.28))' }}
                  />
                </div>

                <div className="sb-side">
                <div className="sb-head w-full">
                  {/* ॐ ऐं सरस्वत्यै नमः */}
                  <div
                    className="sb-mantra mt-1 leading-tight"
                    style={{ fontFamily: DEVANAGARI, color: BRAND_RED, fontWeight: 700, textShadow: '0 1px 0 rgba(255,255,255,0.9), 0 0 18px rgba(240,217,138,0.95)' }}
                  >
                    {MANTRA}
                  </div>
                  <div className="sb-headrule mt-1.5 flex items-center gap-2" aria-hidden="true">
                    <span className="sb-rule h-px" style={{ background: `linear-gradient(90deg, transparent, ${GOLD})` }} />
                    <Rosette size={14} />
                    <span className="sb-rule h-px" style={{ background: `linear-gradient(90deg, ${GOLD}, transparent)` }} />
                  </div>
                </div>


                <div className="sb-words w-full">
                  {/* अज्ञानता का अंधेरा मिट जाए… */}
                  <div
                    className="sb-couplet leading-relaxed"
                    style={{ fontFamily: DEVANAGARI, color: '#6d2230', fontWeight: 600 }}
                  >
                    {COUPLET.map((line) => <div key={line}>{line}</div>)}
                  </div>

                  {/* The foot of the frame, and the house it belongs to. */}
                  <div className="mt-2 flex items-center gap-2" aria-hidden="true">
                    <span className="h-px flex-1" style={{ background: `linear-gradient(90deg, transparent, ${GOLD})` }} />
                    <Rosette size={12} />
                    <span className="h-px flex-1" style={{ background: `linear-gradient(90deg, ${GOLD}, transparent)` }} />
                  </div>
                  <div className="sb-foot mt-1.5 font-semibold" style={{ fontFamily: DEVANAGARI, color: '#9a6a4e' }}>
                    सलासार टेक्नो इंजीनियरिंग · एच.एस.डी.
                  </div>
                </div>
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
