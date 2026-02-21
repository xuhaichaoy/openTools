import type { FC } from "react";

export const ClipboardHistoryIcon: FC<{ className?: string }> = ({
  className,
}) => (
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
        @keyframes clip-slide {
          0%, 100% { transform: translateY(0); opacity: 1; }
          40% { transform: translateY(2px); opacity: 0.8; }
        }
        .clip-anim {
          animation: clip-slide 2s ease-in-out infinite;
        }
      `}
    </style>
    <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    <g className="clip-anim">
      <path d="M12 11h4" />
      <path d="M12 16h4" />
      <path d="M8 11h.01" />
      <path d="M8 16h.01" />
    </g>
  </svg>
);
