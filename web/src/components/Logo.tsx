import { useId } from 'react';

/** Shaddai mark: a folded ribbon S. Blue faces, navy folds. */
export function LogoMark({ size = 28, title }: { size?: number; title?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg
      width={size}
      height={(size * 116) / 124}
      viewBox="-6 -6 124 116"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <linearGradient id={`${id}u`} gradientUnits="userSpaceOnUse" x1="0" y1="16" x2="0" y2="30">
          <stop offset="0" stopColor="#1673C4" />
          <stop offset="1" stopColor="#2FA4FF" />
        </linearGradient>
        <linearGradient id={`${id}d`} gradientUnits="userSpaceOnUse" x1="0" y1="74" x2="0" y2="89">
          <stop offset="0" stopColor="#2FA4FF" />
          <stop offset="1" stopColor="#1673C4" />
        </linearGradient>
        <linearGradient id={`${id}m`} gradientUnits="userSpaceOnUse" x1="0" y1="44" x2="0" y2="58">
          <stop offset="0" stopColor="#1673C4" />
          <stop offset="1" stopColor="#2FA4FF" />
        </linearGradient>
        <clipPath id={`${id}c`}>
          <path d="M22 61.25V30C22 13.43 35.43 0 52 0H82C98.57 0 112 13.43 112 30V43.75H97Q89 43.75 89 51.75V74C89 90.57 75.57 104 59 104H30C13.43 104 0 90.57 0 74V43.75H22Z" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${id}c)`}>
        <rect x="22" y="17" width="18" height="44.25" fill={`url(#${id}u)`} />
        <rect x="94" y="17" width="18" height="26" fill={`url(#${id}u)`} />
        <rect x="72" y="43.75" width="17" height="44.5" fill={`url(#${id}d)`} />
        <rect x="0" y="62" width="18" height="26.5" fill={`url(#${id}d)`} />
        <rect x="72" y="43.75" width="17" height="14" fill={`url(#${id}m)`} opacity=".55" />
        <rect x="40" y="43.75" width="32.5" height="17.5" fill="#0C528D" />
        <rect x="22" y="0" width="90" height="17" fill="#0B4D85" />
        <rect x="0" y="88" width="89" height="16" fill="#0B4D85" />
      </g>
    </svg>
  );
}
