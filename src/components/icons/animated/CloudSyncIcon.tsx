import type { FC } from "react";

export const CloudSyncIcon: FC<{ className?: string }> = ({ className }) => (
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
        @keyframes cloud-arrow-spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @keyframes cloud-float {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-2px); }
        }
        .cloud-sync-anim {
          animation: cloud-float 3s infinite ease-in-out;
        }
        .cloud-arrow-anim {
          transform-origin: 12px 14px;
          animation: cloud-arrow-spin 2s linear infinite;
        }
      `}
    </style>
    <g className="cloud-sync-anim">
      <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
      {/* rotating sync arrow */}
      <path
        d="M9 13a3 3 0 1 1 6 0 3 3 0 0 1-6 0Z"
        className="cloud-arrow-anim"
        strokeDasharray="4 4"
      />
    </g>
  </svg>
);
