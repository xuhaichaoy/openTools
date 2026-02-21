import type { FC } from "react";

export const ImageSearchIcon: FC<{ className?: string }> = ({ className }) => (
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
        @keyframes search-detect {
          0%, 100% { transform: translateX(0) translateY(0); }
          25% { transform: translateX(-2px) translateY(-2px); }
          75% { transform: translateX(2px) translateY(2px); }
        }
        .inspect-anim {
          animation: search-detect 3s ease-in-out infinite;
        }
      `}
    </style>
    <g className="inspect-anim">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </g>
    {/* Inner picture to signify ImageSearch */}
    <path d="m8 12 2-2 3 3" opacity="0.6" className="inspect-anim" />
  </svg>
);
