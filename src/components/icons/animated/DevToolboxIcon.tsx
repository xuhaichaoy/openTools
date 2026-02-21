import type { FC } from "react";

export const DevToolboxIcon: FC<{ className?: string }> = ({ className }) => (
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
        @keyframes dev-wrench-tilt {
          0%, 100% { transform: rotate(0deg); }
          25% { transform: rotate(12deg); }
          75% { transform: rotate(-12deg); }
        }
        .dev-toolbox-anim {
          transform-origin: center;
          animation: dev-wrench-tilt 2s ease-in-out infinite;
        }
      `}
    </style>
    <g className="dev-toolbox-anim">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </g>
  </svg>
);
