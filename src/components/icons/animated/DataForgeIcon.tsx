import type { FC } from "react";

export const DataForgeIcon: FC<{ className?: string }> = ({ className }) => (
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
        @keyframes db-pulse {
          0%, 100% { transform: scaleY(1); opacity: 1; }
          50% { transform: scaleY(1.05); opacity: 0.8; }
        }
        .db-pulse-anim {
          transform-origin: bottom;
          animation: db-pulse 2s infinite ease-in-out;
        }
      `}
    </style>
    <g className="db-pulse-anim">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5V19A9 3 0 0 0 21 19V5" />
      <path d="M3 12A9 3 0 0 0 21 12" />
    </g>
  </svg>
);
