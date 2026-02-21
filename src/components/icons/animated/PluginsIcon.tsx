import type { FC } from "react";

export const PluginsIcon: FC<{ className?: string }> = ({ className }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <style>
      {`
        @keyframes plug-jiggle {
          0%, 100% { transform: rotate(0deg); }
          25% { transform: rotate(-5deg); }
          75% { transform: rotate(5deg); }
        }
        .plug-anim {
          transform-origin: center;
          animation: plug-jiggle 2s ease-in-out infinite;
        }
      `}
    </style>
    <path
      className="plug-anim"
      d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.611c-.941.941-2.468.941-3.408 0L8.73 19.73a1.2 1.2 0 0 1-.289-.877l.136-.902c.045-.298-.016-.605-.171-.851A2.5 2.5 0 0 0 4.14 14.83c-.246.155-.553.216-.851.171l-.902-.136a1.2 1.2 0 0 1-.878-.29L.15 13.215C-.264 12.8-.264 12.13.15 11.716l1.242-1.242c.322-.322.846-.42 1.266-.237a2.5 2.5 0 0 0 3.256-3.256c-.183-.42-.085-.944.237-1.266L7.393.473c.414-.414 1.084-.414 1.498 0l1.359 1.359a1.2 1.2 0 0 1 .289.877l-.136.902c-.045.298.016.605.171.851A2.5 2.5 0 0 0 12.84 6.73c.246-.155.553-.216.851-.171l.902.136a1.2 1.2 0 0 1 .878.29l1.498 1.498c.414.414.414 1.084 0 1.498l-1.498 1.498z"
    />
  </svg>
);
