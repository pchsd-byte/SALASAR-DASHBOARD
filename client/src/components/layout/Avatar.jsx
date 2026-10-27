// One place that knows how to draw a person, so the navbar, the profile page and its picker can
// never disagree about what somebody's picture looks like.
//
// Three kinds, chosen on the Profile page: their Google photo, their initials on one of the
// dashboard's own series colours, or a picture they uploaded (downscaled by the browser to
// 128×128 before it ever leaves it).

// The chart palette, reused so a chosen colour always belongs to the theme and keeps working
// when the theme flips (§5.3 — these are CSS variables, not hex).
export const AVATAR_COLORS = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `var(--series-${n})`);

export function initialsOf(name, email) {
  const source = (name || '').trim() || (email || '').split('@')[0] || '?';
  const words = source.split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[words.length - 1][0] : source.slice(0, 2);
  return letters.toUpperCase();
}

export function Avatar({ user, size = 32, className = '', style = {} }) {
  const kind = user?.avatar?.kind ?? 'google';
  const shared = {
    width: size,
    height: size,
    // Initials shrink with the circle rather than overflowing it at small sizes.
    fontSize: Math.round(size * 0.38),
    ...style,
  };

  if (kind === 'photo' && user?.avatar?.dataUrl) {
    return <img src={user.avatar.dataUrl} alt="" className={`shrink-0 rounded-full object-cover ${className}`} style={shared} />;
  }

  if (kind === 'google' && user?.picture) {
    // referrerPolicy: Google's CDN refuses the image when a referrer is sent from another origin.
    return <img src={user.picture} alt="" referrerPolicy="no-referrer" className={`shrink-0 rounded-full object-cover ${className}`} style={shared} />;
  }

  const color = AVATAR_COLORS[user?.avatar?.colorIndex ?? 0] ?? AVATAR_COLORS[0];
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white ${className}`}
      style={{ ...shared, background: color }}
    >
      {initialsOf(user?.name, user?.email)}
    </span>
  );
}
